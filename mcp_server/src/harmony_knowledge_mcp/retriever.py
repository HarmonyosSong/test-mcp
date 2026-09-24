from __future__ import annotations

import re
from collections.abc import Iterable

from .concepts import concept_score
from .schemas import End, KnowledgeEntry, KnowledgeKind, SearchHit, SearchScope

# 归一化时丢弃标点与空白：中文查询没有词边界，靠短语包含与字符二元组重合度打分。
PUNCTUATION = re.compile(r"[\s，。！？、；：,.!?;:~·\-—_（）()\[\]【】\"'“”]+")

PHRASE_MATCH_SCORE = 3.0
CONTAINMENT_SCORE = 2.7
SUBSTRING_BASE = 0.5
SUBSTRING_STEP = 0.5

# 短于这个长度的公共子串一律不认。用户的原话里到处是「有问题」「失败」「不了」这类泛化片段，
# 放到 3 个字符就会把「登录有问题」和「支付有问题」判成同一条知识。
MIN_SUBSTRING = 4

MIN_SCORE = 0.6

# 端不匹配、版本不匹配时不丢弃条目——它仍可能是有用的线索——但要降权，
# 并且由 SearchHit.end_match / version_match 如实告诉模型它只是线索。
CONTEXT_MISMATCH_PENALTY = 0.4

DEFAULT_LIMIT = 3
MAX_LIMIT = 10


def normalize(text: str) -> str:
    return PUNCTUATION.sub("", text.casefold())


def longest_common_substring_length(left: str, right: str) -> int:
    """最长公共子串长度。

    用最长公共子串而不是字符二元组重合度，是因为用户的原话里会混进大量填充词——
    「用户说戴蓝牙耳机就评测不了」和「蓝牙耳机录音采样率回落」只共享「蓝牙耳机」这一小段，
    任何按查询整体长度归一化的指标都会被填充词拉垮。
    """
    if not left or not right:
        return 0
    previous = [0] * (len(right) + 1)
    best = 0
    for left_index in range(1, len(left) + 1):
        current = [0] * (len(right) + 1)
        for right_index in range(1, len(right) + 1):
            if left[left_index - 1] == right[right_index - 1]:
                current[right_index] = previous[right_index - 1] + 1
                best = max(best, current[right_index])
        previous = current
    return best


def term_score(query: str, term: str) -> float:
    if not query or not term:
        return 0.0
    if term in query:
        return PHRASE_MATCH_SCORE
    # 词条包含查询：短查询（「白屏」「录音」）靠这条命中。
    if len(query) >= 2 and query in term:
        return CONTAINMENT_SCORE
    length = longest_common_substring_length(query, term)
    if length < MIN_SUBSTRING:
        return 0.0
    return min(PHRASE_MATCH_SCORE, SUBSTRING_BASE + SUBSTRING_STEP * length)


def score_entry(query: str, entry: KnowledgeEntry) -> tuple[float, str]:
    """返回 (分数, 命中的短语)。"""
    best_score = 0.0
    best_term = ""
    for term in entry.match_terms:
        candidate = term_score(query, normalize(term))
        if candidate > best_score:
            best_score = candidate
            best_term = term
    semantic_score, semantic_term = concept_score(query, entry.match_terms)
    if semantic_score > best_score:
        return semantic_score, semantic_term
    return best_score, best_term


def parse_version_range(spec: str) -> tuple[float | None, float | None] | None:
    """解析 "5.0-6.0" / "5.0-" / "-6.0" / "5.0"，无法解析时返回 None（视为无约束）。"""
    text = spec.strip()
    if not text:
        return None
    if "-" in text:
        low, _, high = text.partition("-")
        return _to_number(low), _to_number(high)
    return _to_number(text), None


def version_matches(spec: str | None, version: str | None) -> bool:
    """上下文没有版本信息时不下判断，一律视为匹配，避免误降权。"""
    if not spec or not version:
        return True
    bounds = parse_version_range(spec)
    if bounds is None:
        return True
    value = _to_number(version)
    if value is None:
        return True
    low, high = bounds
    if low is not None and value < low:
        return False
    return not (high is not None and value > high)


def search(
    entries: Iterable[KnowledgeEntry],
    query: str,
    *,
    scope: SearchScope = SearchScope.SYMPTOM,
    end: End | None = None,
    version: str | None = None,
    domains: list[str] | None = None,
    limit: int = DEFAULT_LIMIT,
) -> list[SearchHit]:
    normalized_query = normalize(query)
    safe_limit = max(1, min(limit, MAX_LIMIT))
    preferred_domains = set(domains or [])
    hits: list[SearchHit] = []
    for entry in entries:
        if scope is SearchScope.SYMPTOM and entry.kind is not KnowledgeKind.SYMPTOM:
            continue
        if scope is SearchScope.FACT and entry.kind is KnowledgeKind.SYMPTOM:
            continue
        raw_score, matched_on = score_entry(normalized_query, entry)
        # 阈值只作用于原始分数：端/版本不匹配是降权，不是丢弃。
        if raw_score < MIN_SCORE:
            continue
        end_match = end is None or end in entry.applies_to
        version_match = version_matches(entry.applicable_versions, version)
        score = raw_score
        if not end_match:
            score *= CONTEXT_MISMATCH_PENALTY
        if not version_match:
            score *= CONTEXT_MISMATCH_PENALTY
        hits.append(
            SearchHit(
                name=entry.name,
                kind=entry.kind,
                summary=entry.summary,
                score=round(score, 3),
                authority=entry.authority,
                applies_to=entry.applies_to,
                domains=entry.domains,
                domain_match=(
                    bool(preferred_domains.intersection(entry.domains) or "shared" in entry.domains)
                    if preferred_domains
                    else None
                ),
                end_match=end_match,
                version_match=version_match,
                matched_on=matched_on,
                references=entry.references,
            )
        )
    # 业务域只打破文本分数的平局，不制造命中、不遮蔽跨域的强匹配。
    hits.sort(
        key=lambda hit: (
            -hit.score,
            hit.domain_match is False,
            hit.kind is not KnowledgeKind.SYMPTOM,
            hit.name,
        )
    )
    return hits[:safe_limit]


def _to_number(value: str) -> float | None:
    text = value.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None
