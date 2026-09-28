"""预览槽位分配(设计文档 8.2):在最多三篇正文预算内,先保证直接相关事实可见。

V1 固定顺序「top1 → top1 全部引用 → 其余 hits」会让宽泛引用抢占更相关候选的正文
位置(自学课退款事实已进 hits,预览却被学习页症状的引用占满)。本模块只决定
「选哪三篇」,不改正文切片(文档 8.3);阶段二以 V1 hits 做消融,阶段三由 V2 注入
自己的引用相关性评分。
"""

from __future__ import annotations

from collections.abc import Callable

from .retriever import MIN_SCORE, normalize, score_entry
from .schemas import KnowledgeEntry, KnowledgeKind, SearchHit

DIRECT_HIT = "direct_hit"
RELEVANT_REFERENCE = "relevant_reference"
REFERENCE_ONLY = "reference_only"


def select_previews(
    hits: list[SearchHit],
    *,
    query: str,
    resolve: Callable[[str], KnowledgeEntry | None],
    score_reference: Callable[[KnowledgeEntry], float] | None = None,
    threshold: float = MIN_SCORE,
    limit: int = 3,
) -> list[tuple[str, str]]:
    """从最终 hits 与其一跳直接事实引用中确定预览,返回 [(规范 ID, 入选原因)]。

    槽位一固定 hits[0](保持首个候选可解释);槽位二优先给剩余 hits 中分数最高的
    事实,没有则给过门槛引用中相关性最高的事实;剩余槽位先放剩余直接 hits,
    再放过门槛引用;仍有余位才用 hits[0] 的一跳引用补足,标 reference_only——
    纯图关系只说明「可以查看」,不声称直接命中(文档 8.1)。
    """
    if not hits:
        return []
    if score_reference is None:
        normalized_query = normalize(query)

        def score_reference(entry: KnowledgeEntry) -> float:
            return score_entry(normalized_query, entry)[0]

    selected: list[tuple[str, str]] = []
    seen: set[str] = set()

    def put(name: str, reason: str) -> None:
        if name not in seen and len(selected) < limit:
            seen.add(name)
            selected.append((name, reason))

    put(hits[0].name, DIRECT_HIT)
    remaining = hits[1:]

    # 一跳事实引用池:全部先按查询相关性重估,过门槛的才参与槽位二/三。
    reference_scores: dict[str, float] = {}
    for hit in hits:
        for ref in hit.references:
            if ref in seen or ref in reference_scores:
                continue
            entry = resolve(ref)
            if entry is None or entry.kind is KnowledgeKind.SYMPTOM:
                continue
            reference_scores[ref] = score_reference(entry)
    eligible_refs = {ref: score for ref, score in reference_scores.items() if score >= threshold}

    # 槽位二:剩余 hits 中分数最高的事实;没有则给相关性最高的过门槛引用事实。
    fact_hits = [hit for hit in remaining if hit.kind is not KnowledgeKind.SYMPTOM]
    if fact_hits:
        put(fact_hits[0].name, DIRECT_HIT)
    elif eligible_refs:
        best_ref = min(eligible_refs, key=lambda name: (-eligible_refs[name], name))
        put(best_ref, RELEVANT_REFERENCE)

    # 槽位三:先剩余直接 hits,再过门槛引用(相关性降序、ID 字典序)。
    for hit in remaining:
        put(hit.name, DIRECT_HIT)
    for ref in sorted(eligible_refs, key=lambda name: (-eligible_refs[name], name)):
        put(ref, RELEVANT_REFERENCE)

    # 仍有余位:hits[0] 的一跳引用补足(含未过门槛),按相关性降序、ID 字典序。
    if len(selected) < limit:
        leftover = [ref for ref in hits[0].references if ref not in seen]
        leftover.sort(key=lambda name: (-reference_scores.get(name, 0.0), name))
        for ref in leftover:
            entry = resolve(ref)
            if entry is not None and entry.kind is not KnowledgeKind.SYMPTOM:
                put(ref, REFERENCE_ONLY)

    return selected
