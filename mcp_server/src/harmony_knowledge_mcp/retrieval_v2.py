"""V2 检索引擎(非向量):运行模式、版本常量、不可变打分配置与快照标识。

对应 docs/knowledge-retrieval-v2-design.md。阶段一仅交付双模式框架:legacy 为默认,
V2 引擎主体(特征/索引/资格/评分)在阶段三落地;在此之前 v2/shadow 模式启动即报
配置错误,不允许静默降级成 legacy 还宣称是新引擎。
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
ENGINE_VERSION = "v2-stage1"

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
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
