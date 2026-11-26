"""日志 compact 共用：字段清洗、摘要、字符/体积预算。"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# 与聚合护栏对齐；精查 compact / 聚合共用。
VALUE_MAX_CHARS = 600
LOGS_BUDGET_CHARS = 24_000
# UA 摘要抽不出字段时的极短占位长度（P0-2：提示可 full=true 看原文）。
UA_EXCERPT_MAX_CHARS = 80

_SENSITIVE_QUERY_KEYS = frozenset(
    {
        "token",
        "access_token",
        "accesstoken",
        "ticket",
        "id_token",
        "refresh_token",
        "authorization",
        "auth",
    }
)

_UA_KV_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("version", re.compile(r"\bversion=([^\s;]+)", re.I)),
    ("clientType", re.compile(r"\bclientType=([^\s;]+)", re.I)),
    ("dv", re.compile(r"\bdv=([A-Za-z0-9_-]{8,64})", re.I)),
    ("source", re.compile(r"\bsource=([^\s;]+)", re.I)),
    ("env", re.compile(r"\benv=([^\s;]+)", re.I)),
    ("sn", re.compile(r"\bsn=([^\s;]+)", re.I)),
]
_OS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("iOS", re.compile(r"iPhone OS ([0-9_]+)|CPU OS ([0-9_]+)|iPad; CPU OS ([0-9_]+)", re.I)),
    ("Android", re.compile(r"Android[ /]([0-9.]+)", re.I)),
]
_MODEL_PATTERNS = [
    re.compile(r"\((?:Linux; Android [^;]+; |iPhone; |iPad; )([^;)]+)", re.I),
    re.compile(r"Build/([^\s;)]+)", re.I),
]


def clip_strings(value: Any, max_chars: int = VALUE_MAX_CHARS) -> Any:
    """递归截断超长字符串字段值；保留结构。"""
    if isinstance(value, str):
        return value if len(value) <= max_chars else value[: max_chars - 1] + "…"
    if isinstance(value, dict):
        return {k: clip_strings(v, max_chars) for k, v in value.items()}
    if isinstance(value, list):
        return [clip_strings(item, max_chars) for item in value]
    return value


def trim_logs_budget(logs: list[Any], budget: int = LOGS_BUDGET_CHARS) -> tuple[list[Any], int]:
    """按总字符预算收缩 logs；返回 (kept, omitted_count)。"""
    remaining = budget
    omitted = 0
    kept: list[Any] = []
    for entry in logs:
        size = len(json.dumps(entry, ensure_ascii=False))
        if kept and size > remaining:
            omitted += 1
            continue
        kept.append(entry)
        remaining -= size
    return kept, omitted


def trim_grouped_logs_budget(results: list, budget: int = LOGS_BUDGET_CHARS) -> int:
    """按总字符预算收缩各分组的 logs 数组；就地修改并返回省略条数。"""
    remaining = budget
    omitted = 0
    for group in results:
        logs = group.get("logs") or []
        kept = []
        for entry in logs:
            size = len(json.dumps(entry, ensure_ascii=False))
            if kept and size > remaining:
                omitted += 1
                continue
            kept.append(entry)
            remaining -= size
        if len(kept) != len(logs):
            group["logs"] = kept
            group["logs_omitted"] = len(logs) - len(kept)
    return omitted


def scrub_currenthref(value: Any) -> Any:
    """去掉 URL query 中的 token 等敏感参数，保留 path + 业务参数。"""
    if not isinstance(value, str) or not value:
        return value
    try:
        parts = urlsplit(value)
    except Exception:
        return value
    if not parts.query:
        return value
    kept = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in _SENSITIVE_QUERY_KEYS
    ]
    new_query = urlencode(kept, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def summarize_ua(*sources: Any) -> dict[str, str]:
    """从 UA / rsd 等文本抽出设备/App 摘要。"""
    text = " ".join(str(s) for s in sources if isinstance(s, str) and s)
    summary: dict[str, str] = {}
    if not text:
        return summary
    for key, pattern in _UA_KV_PATTERNS:
        match = pattern.search(text)
        if match and match.group(1):
            summary[key] = match.group(1)
    for os_name, pattern in _OS_PATTERNS:
        match = pattern.search(text)
        if match:
            summary["OS"] = os_name
            ver = next((g for g in match.groups() if g), None)
            if ver:
                summary["osVersion"] = ver.replace("_", ".")
            break
    for pattern in _MODEL_PATTERNS:
        match = pattern.search(text)
        if match and match.group(1):
            summary.setdefault("model", match.group(1).strip())
            break
    if "iPad" in text or "iPhone" in text:
        summary.setdefault("OS", "iOS" if "iPhone" in text or "iPad" in text else summary.get("OS", ""))
    return {k: v for k, v in summary.items() if v}


def slim_response_field(value: Any) -> Any:
    """data.response：只保留 code/message；解析失败则丢弃大正文。"""
    parsed: Any = value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return value
        try:
            parsed = json.loads(text)
        except Exception:
            return {"_omitted": True, "_reason": "response_too_large_or_unparsed"}
    if isinstance(parsed, dict):
        out: dict[str, Any] = {}
        if "code" in parsed:
            out["code"] = parsed["code"]
        if "message" in parsed:
            out["message"] = parsed["message"]
        elif "msg" in parsed:
            out["message"] = parsed["msg"]
        if out:
            return out
        return {"_omitted": True, "_reason": "no_code_or_message"}
    return {"_omitted": True, "_reason": "unsupported_response_type"}


def ua_excerpt(*sources: Any, max_chars: int = UA_EXCERPT_MAX_CHARS) -> str | None:
    """UA/rsd 摘要抽不出字段时的极短占位：保留开头片段，提示可 full=true 看原文。"""
    for source in sources:
        if isinstance(source, str) and source.strip():
            text = source.strip()
            return text if len(text) <= max_chars else text[:max_chars] + "…"
    return None


def apply_budget_to_log_rows(
    rows: list[Any],
    *,
    clip: bool = True,
) -> tuple[list[Any], dict[str, Any]]:
    """对精查返回的 logs 做字符串截断 + 总预算；返回 (rows, truncation meta)。

    clip=False 用于 full=true：全字段按工具契约原样返回，只做总预算收缩。
    """
    prepared = [clip_strings(row) for row in rows] if clip else list(rows)
    kept, omitted = trim_logs_budget(prepared)
    meta: dict[str, Any] = {}
    if omitted:
        meta["truncated"] = True
        meta["logs_omitted"] = omitted
    return kept, meta
