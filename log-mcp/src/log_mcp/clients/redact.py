"""日志脱敏，两侧共用。

移植自 `dev-agent-logs/src/appx/log.mjs::redact`：
  - key 名匹配 authorization|cookie|token|access[-_]?key|secret|password|passwd|sign|
    session|jwt → <redacted>
  - 字符串值：手机号 → <phone>，身份证号 → <id-card>，URL 内 token=xxx 等参数 → <redacted>
  - NaN / ±Infinity → null
  - undefined 字段丢弃
"""

from __future__ import annotations

import re
from typing import Any

_SENSITIVE_KEY = re.compile(
    r"(authorization|cookie|token|access[-_]?key|secret|password|passwd|sign|session|jwt)",
    re.IGNORECASE,
)
_PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
_ID_CARD = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
_URL_PARAM = re.compile(
    r"(authorization|cookie|token|sign|password|secret)=([^&\s]+)",
    re.IGNORECASE,
)


def _redact_string(value: str) -> str:
    """对字符串值做手机号 / 身份证 / URL 参数脱敏。"""
    redacted = _URL_PARAM.sub(r"\1=<redacted>", value)
    redacted = _PHONE.sub("<phone>", redacted)
    redacted = _ID_CARD.sub("<id-card>", redacted)
    return redacted


def redact(value: Any) -> Any:
    """递归脱敏；保留结构，仅替换敏感值。"""
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, val in value.items():
            if val is None:
                out[key] = None
                continue
            if _SENSITIVE_KEY.search(str(key)):
                out[key] = "<redacted>"
            else:
                out[key] = redact(val)
        return out
    if isinstance(value, float):
        # NaN / ±Infinity 归为 null，保证 JSON 安全
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return value
    if isinstance(value, str):
        return _redact_string(value)
    return value
