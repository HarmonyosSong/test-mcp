"""时间范围解析：相对 / 自然语言 / 绝对区间 → (start_sec, end_sec)。

移植自 `dev-agent-logs/src/appx/log.mjs::parseTimeRange`，并扩展 Agent 常见写法：
  - 相对：15m, 1h, 30min, 2hour, 3d, 1w
  - 自然语言：今天, 昨天, 前天, 本周, 上周, 过去N天, 过去N周
  - 绝对日期：YYYY-MM-DD（整天）
  - 时间段：今天9:00到10:00 / YYYY-MM-DD HH:MM到HH:MM（左闭右开）
  - 扩展：分隔符 to/~ ；可选秒 :SS ；两端完整日期时间
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

# 供工具 Field(description=...) 复用，引导 Agent 使用可解析格式。
TIME_PARAM_DESCRIPTION = (
    "时间范围。支持：15m/1h/昨天/今天；"
    "今天9:00到10:00；"
    "2026-11-11 07:00-07:40；"
    "2026-11-11 07:00:00 to 2026-11-11 07:40:00。"
    "分隔符可用 到/-/至/to/~，时间可带秒。"
)

_REL_UNITS = {
    "m": 60,
    "min": 60,
    "h": 3600,
    "hour": 3600,
    "d": 86400,
    "day": 86400,
    "w": 604800,
    "week": 604800,
}
_DAY_MAP = {"今天": 0, "today": 0, "昨天": 1, "yesterday": 1, "前天": 2}

# 到 / - / 至 / to / ~
_SEP = r"(?:到|-|至|to|~)"
# HH:MM 或 HH:MM:SS
_HMS = r"(\d{1,2}):(\d{2})(?::(\d{2}))?"
_YMD = r"(\d{4})-(\d{1,2})-(\d{1,2})"


def _to_sec(dt: datetime) -> int:
    return int(dt.timestamp())


def _hms(groups: tuple[str | None, ...], *, hour_i: int) -> tuple[int, int, int]:
    """从 groups 中按 hour_i 起取 hour/minute/optional second。"""
    hour = int(groups[hour_i])
    minute = int(groups[hour_i + 1])
    second = int(groups[hour_i + 2] or 0)
    return hour, minute, second


def parse_time_range(text: str, now: datetime | None = None) -> tuple[int, int] | None:
    """解析时间范围字符串为 (start_sec, end_sec)；无法解析返回 None。"""
    raw = (text or "").strip()
    if not raw:
        return None
    now = now or datetime.now()

    # 1) 今天/昨天/前天 HH:MM[:SS] 到 HH:MM[:SS]
    m = re.search(
        rf"(今天|昨天|前天|today|yesterday)\s*{_HMS}\s*{_SEP}\s*{_HMS}",
        raw,
        re.IGNORECASE,
    )
    if m:
        day = m.group(1)
        sh, sm, ss = _hms(m.groups(), hour_i=1)
        eh, em, es = _hms(m.groups(), hour_i=4)
        base = now - timedelta(days=_DAY_MAP[day.lower()])
        start = base.replace(hour=sh, minute=sm, second=ss, microsecond=0)
        end = base.replace(hour=eh, minute=em, second=es, microsecond=0)
        return _to_sec(start), _to_sec(end)

    # 2) YYYY-MM-DD HH:MM[:SS] 到 YYYY-MM-DD HH:MM[:SS]（两端完整日期时间）
    m = re.search(
        rf"{_YMD}\s+{_HMS}\s*{_SEP}\s*{_YMD}\s+{_HMS}",
        raw,
        re.IGNORECASE,
    )
    if m:
        g = m.groups()
        y1, mo1, d1 = int(g[0]), int(g[1]), int(g[2])
        sh, sm, ss = _hms(g, hour_i=3)
        y2, mo2, d2 = int(g[6]), int(g[7]), int(g[8])
        eh, em, es = _hms(g, hour_i=9)
        start = datetime(y1, mo1, d1, sh, sm, ss)
        end = datetime(y2, mo2, d2, eh, em, es)
        return _to_sec(start), _to_sec(end)

    # 3) YYYY-MM-DD HH:MM[:SS] 到 HH:MM[:SS]（同一天，结束侧仅时间）
    m = re.search(
        rf"{_YMD}\s+{_HMS}\s*{_SEP}\s*{_HMS}",
        raw,
        re.IGNORECASE,
    )
    if m:
        g = m.groups()
        y, mo, d = int(g[0]), int(g[1]), int(g[2])
        sh, sm, ss = _hms(g, hour_i=3)
        eh, em, es = _hms(g, hour_i=6)
        start = datetime(y, mo, d, sh, sm, ss)
        end = datetime(y, mo, d, eh, em, es)
        return _to_sec(start), _to_sec(end)

    lower = raw.lower()

    # 4) 相对时间 N{单位}
    m = re.match(r"^(\d+)\s*(min|m|h|hour|d|day|w|week)$", lower)
    if m:
        n = int(m.group(1))
        sec = n * _REL_UNITS[m.group(2)]
        end = int(now.timestamp())
        return end - sec, end

    # 5) 今天 / 昨天 / 前天
    if lower in {"今天", "today"}:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return _to_sec(start), int(now.timestamp())
    if lower in {"昨天", "yesterday"}:
        day = now - timedelta(days=1)
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        end = day.replace(hour=23, minute=59, second=59, microsecond=0)
        return _to_sec(start), _to_sec(end)
    if lower == "前天":
        day = now - timedelta(days=2)
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        end = day.replace(hour=23, minute=59, second=59, microsecond=0)
        return _to_sec(start), _to_sec(end)

    # 6) 本周 / 上周
    if lower in {"本周", "this week", "这周"}:
        monday = now.replace(hour=0, minute=0, second=0, microsecond=0)
        dow = monday.weekday()  # 0=周一
        monday = monday - timedelta(days=dow)
        return _to_sec(monday), int(now.timestamp())
    if lower in {"上周", "last week", "上一周"}:
        monday = now.replace(hour=0, minute=0, second=0, microsecond=0)
        dow = monday.weekday()
        last_monday = monday - timedelta(days=dow + 7)
        last_sunday = last_monday + timedelta(days=6)
        end = last_sunday.replace(hour=23, minute=59, second=59, microsecond=0)
        return _to_sec(last_monday), _to_sec(end)

    # 7) 过去 N 天 / N 周
    m = re.search(r"过去\s*(\d+)\s*天", lower)
    if m:
        day = now - timedelta(days=int(m.group(1)))
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        return _to_sec(start), int(now.timestamp())
    m = re.search(r"过去\s*(\d+)\s*周", lower)
    if m:
        day = now - timedelta(weeks=int(m.group(1)))
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        return _to_sec(start), int(now.timestamp())

    # 8) 绝对日期 YYYY-MM-DD（整天）
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", raw)
    if m:
        y, mo, d = m.groups()
        start = datetime(int(y), int(mo), int(d), 0, 0, 0)
        end = datetime(int(y), int(mo), int(d), 23, 59, 59)
        return _to_sec(start), _to_sec(end)

    return None
