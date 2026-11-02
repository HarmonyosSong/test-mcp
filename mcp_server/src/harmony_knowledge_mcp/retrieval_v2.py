"""V2 检索引擎(非向量):运行模式、版本常量、不可变打分配置、快照标识与引擎主体。

对应 docs/knowledge-retrieval-v2-design.md。阶段一交付双模式框架;阶段三落地引擎:
特征抽取(retrieval_rules.py)→ 候选生成(完整符号/意图短语/业务对象倒排)→
资格门槛(E/P/O/C,与分数分离)→ 统一评分与确定性排序 → 结果状态。
分数是相关性排序量,不是概率;初始参数只是可复现的实验起点。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

    from .schemas import KnowledgeEntry

# 检索版本与分数口径标识,随响应与日志输出,支持新旧混合分析(文档 9.2/10.3)。
RETRIEVAL_VERSION_V1 = "lexical-v1"
RETRIEVAL_VERSION_V2 = "deterministic-v2"
SCORE_KIND_V1 = "legacy-0-to-3"
SCORE_KIND_V2 = "relevance-0-to-1"

# 检索相关性状态(文档 7.5):描述检索层,不是诊断结论。V1 不推导强弱,统一 legacy_unclassified。
STATUS_LEGACY = "legacy_unclassified"
STATUS_NO_MATCH = "no_match"
STATUS_INSUFFICIENT = "insufficient_query"
STATUS_AMBIGUOUS = "ambiguous"
STATUS_LEADS = "leads_found"

# 引擎行为(词表/资格/评分语义)变化时必须更新:它进入快照标识,让历史日志可按版本归因。
ENGINE_VERSION = "v2-transfer-context-1"

RETRIEVAL_MODE_ENV = "HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE"

# V2 行为:查询超过此长度明确报参数错误,不静默截断(文档 11.2);legacy 保持旧行为。
MAX_QUERY_CHARS = 4096


class RetrievalMode(StrEnum):
    LEGACY = "legacy"
    SHADOW = "shadow"
    V2 = "v2"


class RetrievalConfigError(ValueError):
    """检索模式或打分配置非法:启动期失败,不在请求期吞掉。"""


def resolve_mode(value: str | None = None) -> RetrievalMode:
    """解析运行模式;参数优先,其次环境变量,缺省 legacy。非法值报配置错误。"""
    raw = (value if value is not None else os.environ.get(RETRIEVAL_MODE_ENV, "")).strip().lower()
    if not raw:
        return RetrievalMode.LEGACY
    try:
        return RetrievalMode(raw)
    except ValueError as exc:
        raise RetrievalConfigError(
            f"{RETRIEVAL_MODE_ENV}={raw!r} 非法,取值为 legacy / shadow / v2"
        ) from exc


@dataclass(frozen=True, slots=True)
class RetrievalConfig:
    """V2 资格门槛与打分权重(文档 7.1-7.2 的初始实验值,不是已测得的生产最优)。

    集中定义是为了快照标识与回归复现;任何模块不得另写同款魔法数字。
    """

    object_coverage_threshold: float = 0.50  # 资格 O:加权对象覆盖率下限
    min_raw_score: float = 0.35  # 直接候选的 S_raw 下限(上下文降权前判断)
    ambiguous_gap: float = 0.10  # 前两名 S_raw 差小于此值且对象集不同 -> 歧义提示
    weight_object: float = 0.55
    weight_phrase: float = 0.20
    weight_action: float = 0.15
    weight_facet: float = 0.10
    symbol_pathway: float = 0.90  # 完整精确符号独立通路分
    phrase_pathway: float = 0.75  # 已审核意图短语独立通路分
    context_penalty: float = 0.40  # 端/版本不匹配的降权系数(保留为线索)

    def __post_init__(self) -> None:
        for name in (
            "object_coverage_threshold",
            "min_raw_score",
            "ambiguous_gap",
            "weight_object",
            "weight_phrase",
            "weight_action",
            "weight_facet",
            "symbol_pathway",
            "phrase_pathway",
            "context_penalty",
        ):
            if not 0.0 <= getattr(self, name) <= 1.0:
                raise RetrievalConfigError(f"RetrievalConfig.{name} 必须在 [0,1]")
        total = self.weight_object + self.weight_phrase + self.weight_action + self.weight_facet
        if abs(total - 1.0) > 1e-9:
            raise RetrievalConfigError(f"业务权重之和必须为 1,当前为 {total}")


def build_snapshot_id(
    entries: list[KnowledgeEntry],
    *,
    root: Path,
    rules_digest: str,
    config: RetrievalConfig,
    response_policy: str = "",
) -> str:
    """快照标识:内容文件 + 词表规则 + 打分配置 + 引擎版本的联合摘要(文档 11.1)。

    只用条目数量或 mtime 判断一致性不够:同一语料、规则、配置必须产生同一标识,
    文件载入顺序不影响结果。
    """
    file_hashes = {}
    for entry in entries:
        path = root / entry.source_path
        file_hashes[entry.source_path] = hashlib.sha256(path.read_bytes()).hexdigest()
    payload = {
        "files": file_hashes,
        "rules": rules_digest,
        "config": asdict(config),
        "engine": ENGINE_VERSION,
        "response_policy": response_policy,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


# ---------- 阶段三:引擎主体(文档 5-8 节) ----------

import math  # noqa: E402

from .retrieval_rules import (  # noqa: E402
    CONCEPT_REGISTRY,
    ConceptKind,
    QueryFeatures,
    analyze_entry_text,
    analyze_query,
    contexts_in,
    extract_facets,
    external_subject_hint,
    registered_symbols_in,
)
from .retriever import version_matches  # noqa: E402
from .schemas import End, KnowledgeKind, SearchHit, SearchScope  # noqa: E402

_KIND_OF = {concept.concept_id: concept.kind for concept in CONCEPT_REGISTRY}
_RELATED_TO = {concept.concept_id: concept.related_to for concept in CONCEPT_REGISTRY}


@dataclass(frozen=True, slots=True)
class CandidateTrace:
    """单候选的评分分解与资格判定(文档 7.x);遥测 reason_codes 与逐题归因的来源。"""

    name: str
    qualified: bool
    qualify_path: str  # E 完整符号 / P 意图短语 / O 对象 / C 场景+限定 / 空为不合格
    object_coverage: float
    phrase_hit: bool
    action_coverage: float
    facet_coverage: float
    symbol_hit: bool
    raw_score: float
    reasons: tuple[str, ...]


@dataclass(slots=True)
class LookupResult:
    hits: list[SearchHit]
    status: str
    reason_codes: list[str]
    features: QueryFeatures
    traces: list[CandidateTrace]


class RetrievalEngine:
    """不可变快照上的纯检索函数(文档 11.1):构建后只读,可安全用于线程池。

    89 条规模对全库逐条评分(文档 6.2 允许初版全扫);资格(E/P/O/C)先于分数,
    任何 IDF 或字段叠加都不能让「只有通用片段」的候选越过门槛(文档 7.1)。
    """

    def __init__(
        self, entries: list[KnowledgeEntry], config: RetrievalConfig | None = None
    ) -> None:
        self.config = config or RetrievalConfig()
        self.entries = {entry.name: entry for entry in entries}
        self._concepts: dict[str, frozenset[str]] = {}
        self._objects: dict[str, frozenset[str]] = {}
        self._actions: dict[str, frozenset[str]] = {}
        self._intents: dict[str, frozenset[str]] = {}
        self._symbols: dict[str, frozenset[str]] = {}
        self._facets: dict[str, frozenset[tuple[str, str]]] = {}
        self._contexts: dict[str, frozenset[str]] = {}
        for entry in entries:
            text = " ".join([entry.title, entry.summary, *entry.aliases])
            concepts = analyze_entry_text(text)
            self._concepts[entry.name] = concepts
            self._objects[entry.name] = frozenset(
                concept for concept in concepts if _KIND_OF[concept] is ConceptKind.OBJECT
            )
            self._actions[entry.name] = frozenset(
                concept for concept in concepts if _KIND_OF[concept] is ConceptKind.ACTION
            )
            self._intents[entry.name] = frozenset(
                concept for concept in concepts if _KIND_OF[concept] is ConceptKind.INTENT
            )
            self._symbols[entry.name] = registered_symbols_in(text) | {entry.name}
            self._facets[entry.name] = extract_facets(text)
            self._contexts[entry.name] = contexts_in(text)
        # df 按不同条目数(跨字段去重);N 为快照全部条目数,不按域或 scope 重算(文档 6.1)。
        entry_count = max(1, len(entries))
        df: dict[str, int] = {}
        for concepts in self._concepts.values():
            for concept in concepts:
                df[concept] = df.get(concept, 0) + 1
        self._idf = {
            concept: min(3.0, max(1.0, math.log((entry_count + 1) / (count + 1)) + 1.0))
            for concept, count in df.items()
        }

    def evaluate(self, entry: KnowledgeEntry, features: QueryFeatures) -> CandidateTrace:
        cfg = self.config
        shared_objects = features.objects & self._objects[entry.name]
        query_object_weight = sum(self._idf.get(o, 1.0) for o in features.objects)
        object_coverage = (
            sum(self._idf.get(o, 1.0) for o in shared_objects) / query_object_weight
            if query_object_weight
            else 0.0
        )
        shared_actions = features.actions & self._actions[entry.name]
        query_action_weight = sum(self._idf.get(a, 1.0) for a in features.actions)
        action_coverage = (
            sum(self._idf.get(a, 1.0) for a in shared_actions) / query_action_weight
            if query_action_weight
            else 0.0
        )
        # 单独的「家长」只是说话人的身份,不让它把购课单故障抬到一对一购课。
        # 同时提及多个角色时才比较角色差异(例如家长 vs 顾问的名额口径)。
        roles = {value for kind, value in features.facets if kind == "role"}
        scoring_facets = frozenset(
            facet for facet in features.facets if facet[0] != "role" or len(roles) > 1
        )
        shared_facets = scoring_facets & self._facets[entry.name]
        facet_coverage = len(shared_facets) / len(scoring_facets) if scoring_facets else 0.0
        phrase_hit = bool(features.intents & self._intents[entry.name])
        symbol_hit = bool(features.symbols & self._symbols[entry.name])

        qualified_o = bool(shared_objects) and object_coverage >= cfg.object_coverage_threshold
        shared_contexts = features.contexts & self._contexts[entry.name]
        # 附近/地域/界面形态不能单独创建候选;只有同一明确业务场景内才允许。
        # 查询已有业务对象时不走此通路,避免用限定条件绕过对象覆盖门槛。
        qualified_c = (
            not features.objects
            and bool(shared_contexts)
            and any(kind in {"topic", "region"} for kind, _ in shared_facets)
        )
        qualified = symbol_hit or phrase_hit or qualified_o or qualified_c
        qualify_path = (
            "E"
            if symbol_hit
            else "P"
            if phrase_hit
            else "O"
            if qualified_o
            else "C"
            if qualified_c
            else ""
        )
        s_business = (
            cfg.weight_object * max(object_coverage, float(qualified_c))
            + cfg.weight_phrase * phrase_hit
            + cfg.weight_action * action_coverage
            + cfg.weight_facet * facet_coverage
        )
        raw_score = max(
            s_business, cfg.symbol_pathway * symbol_hit, cfg.phrase_pathway * phrase_hit
        )
        reasons: list[str] = []
        if shared_objects:
            reasons.append("object:" + ",".join(sorted(shared_objects)))
        if shared_actions:
            reasons.append("action:" + ",".join(sorted(shared_actions)))
        if shared_facets:
            reasons.append("facet:" + ",".join(f"{k}={v}" for k, v in sorted(shared_facets)))
        if phrase_hit:
            reasons.append("intent-phrase")
        if symbol_hit:
            reasons.append("exact-symbol")
        if qualified_c:
            reasons.append("context:" + ",".join(sorted(shared_contexts)))
        if not qualified:
            reasons.append("rejected:no-anchor")
        return CandidateTrace(
            name=entry.name,
            qualified=qualified,
            qualify_path=qualify_path,
            object_coverage=round(object_coverage, 6),
            phrase_hit=phrase_hit,
            action_coverage=round(action_coverage, 6),
            facet_coverage=round(facet_coverage, 6),
            symbol_hit=symbol_hit,
            raw_score=round(raw_score, 6),
            reasons=tuple(reasons[:6]),
        )

    def reference_score(
        self,
        entry: KnowledgeEntry,
        features: QueryFeatures,
        *,
        end: End | None = None,
        version: str | None = None,
    ) -> float:
        """正文相关性不能绕过候选资格;不适用的引用降权后仍可作为图线索。"""
        trace = self.evaluate(entry, features)
        if not trace.qualified or trace.raw_score < self.config.min_raw_score:
            return 0.0
        score = trace.raw_score
        if end is not None and end not in entry.applies_to:
            score *= self.config.context_penalty
        if not version_matches(entry.applicable_versions, version):
            score *= self.config.context_penalty
        return score

    def lookup(
        self,
        query: str,
        *,
        end: End | None = None,
        version: str | None = None,
        domains: list[str] | None = None,
        limit: int = 3,
        unified: bool = True,
    ) -> LookupResult:
        """主流程(文档 12.2);unified=False 是消融 C 的症状直通保留开关。"""
        if len(query) > MAX_QUERY_CHARS:
            raise ValueError(
                f"query 长度超过 {MAX_QUERY_CHARS} 字符上限;请提取技术锚点或改用日志工具"
            )
        features = analyze_query(query, canonical_ids=self.entries)
        if unified:
            hits, traces = self._rank(features, self.entries.values(), end, version, domains, limit)
        else:
            symptom_entries = [
                entry for entry in self.entries.values() if entry.kind is KnowledgeKind.SYMPTOM
            ]
            hits, traces = self._rank(features, symptom_entries, end, version, domains, limit)
            if not hits:
                hits, traces = self._rank(
                    features, self.entries.values(), end, version, domains, limit
                )
        status, reason_codes = self._classify(features, hits)
        return LookupResult(
            hits=hits, status=status, reason_codes=reason_codes, features=features, traces=traces
        )

    def search(
        self,
        query: str,
        *,
        scope: SearchScope,
        end: End | None = None,
        version: str | None = None,
        domains: list[str] | None = None,
        limit: int = 3,
    ) -> list[SearchHit]:
        """显式 scope 检索(文档 9.1):严格遵守 scope,不做症状直通,不推导状态。"""
        if len(query) > MAX_QUERY_CHARS:
            raise ValueError(
                f"query 长度超过 {MAX_QUERY_CHARS} 字符上限;请提取技术锚点或改用日志工具"
            )
        features = analyze_query(query, canonical_ids=self.entries)
        if scope is SearchScope.SYMPTOM:
            pool = [entry for entry in self.entries.values() if entry.kind is KnowledgeKind.SYMPTOM]
        elif scope is SearchScope.FACT:
            pool = [
                entry for entry in self.entries.values() if entry.kind is not KnowledgeKind.SYMPTOM
            ]
        else:
            pool = list(self.entries.values())
        hits, _ = self._rank(features, pool, end, version, domains, min(max(1, limit), 10))
        return hits

    def _rank(
        self,
        features: QueryFeatures,
        pool,
        end: End | None,
        version: str | None,
        domains: list[str] | None,
        limit: int,
    ) -> tuple[list[SearchHit], list[CandidateTrace]]:
        preferred = set(domains or [])
        traces = [self.evaluate(entry, features) for entry in pool]
        hits: list[tuple[float, SearchHit]] = []
        for trace in traces:
            if not trace.qualified or trace.raw_score < self.config.min_raw_score:
                continue
            entry = self.entries[trace.name]
            end_match = end is None or end in entry.applies_to
            version_match = version_matches(entry.applicable_versions, version)
            final = trace.raw_score
            if not end_match:
                final *= self.config.context_penalty
            if not version_match:
                final *= self.config.context_penalty
            final = round(final, 6)
            hits.append(
                (
                    final,
                    SearchHit(
                        name=entry.name,
                        kind=entry.kind,
                        summary=entry.summary,
                        score=final,
                        authority=entry.authority,
                        applies_to=entry.applies_to,
                        domains=entry.domains,
                        domain_match=(
                            bool(preferred.intersection(entry.domains) or "shared" in entry.domains)
                            if preferred
                            else None
                        ),
                        end_match=end_match,
                        version_match=version_match,
                        matched_on=trace.reasons[0][:160] if trace.reasons else "",
                        references=entry.references,
                        retrieval_version=RETRIEVAL_VERSION_V2,
                        score_kind=SCORE_KIND_V2,
                        match_reasons=list(trace.reasons[:6]),
                    ),
                )
            )
        hits.sort(
            key=lambda item: (
                -item[0],
                item[1].domain_match is False,
                item[1].kind is not KnowledgeKind.SYMPTOM,
                item[1].name,
            )
        )
        return [hit for _, hit in hits[:limit]], traces

    def _classify(self, features: QueryFeatures, hits: list[SearchHit]) -> tuple[str, list[str]]:
        """结果状态(文档 7.5):检索相关性状态,不是诊断结论。"""
        if not hits:
            insufficient = features.generic_only or not features.normalized_text.strip()
            codes = ["empty-or-generic-only" if insufficient else "no-qualified-candidate"]
            # 外部主体词只是「项目外」提示,不是排除依据;有命中时绝不附加。
            if external_subject_hint(features.raw_query):
                codes.append("possible-external-subject")
            return (STATUS_INSUFFICIENT if insufficient else STATUS_NO_MATCH), codes
        codes: list[str] = []
        if not (features.objects or features.symbols or features.intents):
            codes.append("contextual-qualifier-only")
        if features.objects and not (
            features.actions or features.facets or features.symbols or features.intents
        ):
            codes.append("broad-object-only")
        if len(hits) >= 2:
            top, second = hits[0], hits[1]
            reference_pair = top.kind is KnowledgeKind.SYMPTOM and second.name in top.references
            top_objects = features.objects & self._objects[top.name]
            second_objects = features.objects & self._objects[second.name]
            if (
                not reference_pair
                and abs(top.score - second.score) < self.config.ambiguous_gap
                and top_objects != second_objects
            ):
                codes.append("competing-objects")
        if all(not (hit.end_match and hit.version_match) for hit in hits):
            codes.append("context-mismatch")
        return (STATUS_AMBIGUOUS, codes) if codes else (STATUS_LEADS, [])
