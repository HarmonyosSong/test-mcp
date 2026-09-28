"""dev-knowledge 风格 CJK bigram 加权检索(移植精简版),用于与生产 retriever 对照。

移植自 dev-knowledge knowledge-mcp 的 retrieval.py / ranking.py,砍掉我们知识模型
没有的维度(section 章节、枚举路由、限定词、literal 标识符路由),字段映射:

- alias  ← product.recognition_term(用户叫法,最高杠杆)
- title  ← topic.title
- summary ← topic.summary(dev-knowledge 在 MCP 路由时对 summary ×2,这里直接给 6)
- name   ← topic.identity(规范 ID,ASCII 标识符)

评分公式照抄:token_score = field_weight * (0.35*matched_weight + 1.2*coverage),
短语精确命中再加 EXACT_BONUS;字段内命中数受 FIELD_HIT_CAPS 限制。
"""
from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

# 问句套语在切 bigram 前剥除,避免「有哪些环节」造出跨词 bigram「些环」。(照抄 dev-knowledge)
QUESTION_RE = re.compile(
    "什么情况下|有哪些|哪几个|哪几种|哪些|多少个|多少种|几个|几种|"
    "能不能|可不可以|怎么|如何|什么|是否|为什么|请问|吗|呢"
)
# 泛化词不提供区分度,仅在查询侧剔除。(照抄 dev-knowledge)
GENERIC_TOKENS = {"使用", "可以", "支持", "用户", "页面", "当前", "结果", "查看"}

_CJK_RE = re.compile(r"[一-鿿]+")
_ASCII_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[._:/#@-]+[a-z0-9]+)+|[a-z0-9]+", re.IGNORECASE)
_ASCII_SPLIT_RE = re.compile(r"[._:/#@-]+")

FIELD_WEIGHTS = {"alias": 12.0, "title": 14.0, "summary": 6.0, "name": 8.0}
EXACT_BONUS = {"alias": 24.0, "title": 12.0, "name": 10.0}
FIELD_HIT_CAPS = {"alias": 2, "title": 1, "summary": 1, "name": 2}


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", value).lower()
    chars = []
    for char in text:
        category = unicodedata.category(char)
        chars.append(char if char.isalnum() or category.startswith("L") else " ")
    return " ".join("".join(chars).split())


def tokenize(value: str) -> tuple[str, ...]:
    nfkc = unicodedata.normalize("NFKC", value).lower()
    normalized = normalize_text(value)
    tokens: set[str] = set()
    if normalized:
        tokens.add(normalized)
        tokens.update(normalized.split())
    for match in _CJK_RE.finditer(normalized):
        phrase = match.group(0)
        tokens.add(phrase)
        if len(phrase) >= 2:
            tokens.update(phrase[i : i + 2] for i in range(len(phrase) - 1))
    for match in _ASCII_TOKEN_RE.finditer(nfkc):
        token = match.group(0).strip("._:/#@-")
        if token:
            tokens.add(token)
            tokens.update(part for part in _ASCII_SPLIT_RE.split(token) if part)
    return tuple(sorted(tokens))


def query_tokens(value: str) -> tuple[str, ...]:
    return tuple(
        token for token in tokenize(QUESTION_RE.sub(" ", value)) if token not in GENERIC_TOKENS
    )


@dataclass(frozen=True, slots=True)
class Posting:
    entry_index: int
    field: str
    text: str
    normalized: str
    weight: float
    posting_weight: float  # sum(idf(token) for token in tokens(text))


@dataclass(slots=True)
class BigramIndex:
    entries: list
    postings: list[Posting]
    inverted: dict[str, list[int]]  # token -> posting 下标
    idf: dict[str, float]


def build_index(entries) -> BigramIndex:
    """全量语料建索引(含 idf);scope 过滤在查询侧做,与 dev-knowledge in_scope 一致。"""
    raw = []  # (entry_index, field, text, normalized, tokens)
    inverted: dict[str, list[int]] = {}
    for entry_index, entry in enumerate(entries):
        fields = [("title", entry.title), ("summary", entry.summary), ("name", entry.name)]
        fields += [("alias", alias) for alias in entry.aliases]
        for field_name, text in fields:
            normalized = normalize_text(text)
            if not normalized:
                continue
            tokens = set(tokenize(text))
            raw.append((entry_index, field_name, text, normalized, tokens))
            for token in tokens:
                inverted.setdefault(token, []).append(len(raw) - 1)
    entry_count = max(1, len(entries))
    idf = {
        token: math.log((entry_count + 1) / (len({raw[i][0] for i in idxs}) + 1)) + 1.0
        for token, idxs in inverted.items()
    }
    postings = [
        Posting(
            entry_index,
            field_name,
            text,
            normalized,
            FIELD_WEIGHTS[field_name],
            sum(idf.get(token, 1.0) for token in tokens),
        )
        for entry_index, field_name, text, normalized, tokens in raw
    ]
    return BigramIndex(list(entries), postings, inverted, idf)


def score_entries(
    index: BigramIndex, query: str, *, strict: bool = False
) -> list[tuple[int, float, str]]:
    """返回 [(entry_index, score, matched_on)],按分数降序;零分条目不返回。

    strict=True 加两道闸门(针对 89 条单域小语料的误放收敛):
    短语精确加成要求 posting 归一化文本 ≥3 字(2 字词「登录」「手机」被无关查询
    包含时不得领 EXACT_BONUS);候选条目命中 token 的 idf 和须 ≥ 4.0(单个泛化
    bigram「没有」不足以立案)。
    """
    normalized_query = normalize_text(query)
    matched: dict[int, set[str]] = {}
    for token in query_tokens(query):
        for posting_idx in index.inverted.get(token, ()):
            matched.setdefault(posting_idx, set()).add(token)
    per_entry: dict[int, dict[str, list[tuple[float, str]]]] = {}
    entry_tokens: dict[int, set[str]] = {}
    for posting_idx, matched_tokens in matched.items():
        posting = index.postings[posting_idx]
        matched_weight = sum(index.idf.get(token, 1.0) for token in matched_tokens)
        coverage = matched_weight / posting.posting_weight if posting.posting_weight else 0.0
        token_score = posting.weight * (0.35 * matched_weight + 1.2 * coverage)
        min_phrase_len = 3 if strict else 2
        phrase = posting.normalized == normalized_query or (
            len(posting.normalized) >= min_phrase_len and posting.normalized in normalized_query
        )
        total = token_score + (EXACT_BONUS.get(posting.field, 0.0) if phrase else 0.0)
        fields = per_entry.setdefault(posting.entry_index, {})
        fields.setdefault(posting.field, []).append((total, posting.text))
        entry_tokens.setdefault(posting.entry_index, set()).update(matched_tokens)
    results = []
    for entry_index, fields in per_entry.items():
        if strict:
            distinctive = sum(
                index.idf.get(token, 1.0)
                for token in entry_tokens.get(entry_index, ())
                if len(token) >= 2 and " " not in token
            )
            if distinctive < 4.0:
                continue
        score = 0.0
        best_text = ""
        best_total = -1.0
        for field_name, hits in fields.items():
            hits.sort(key=lambda item: (-item[0], item[1]))
            kept = hits[: FIELD_HIT_CAPS.get(field_name, 1)]
            score += sum(total for total, _ in kept)
            if kept and kept[0][0] > best_total:
                best_total, best_text = kept[0]
        results.append((entry_index, score, best_text))
    results.sort(key=lambda item: (-item[1], index.entries[item[0]].name))
    return results
