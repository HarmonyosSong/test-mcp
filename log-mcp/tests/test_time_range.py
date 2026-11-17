"""时间范围解析测试。"""

from __future__ import annotations

from datetime import datetime

from log_mcp.clients.time_range import parse_time_range


def test_relative_minutes() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)
    start, end = parse_time_range("15m", now)
    assert end - start == 900
    assert end == int(now.timestamp())


def test_relative_hours_days_weeks() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)
    for text, expected in [("1h", 3600), ("3d", 86400 * 3), ("1w", 604800)]:
        start, end = parse_time_range(text, now)
        assert end - start == expected


def test_today_and_yesterday() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)
    start, end = parse_time_range("今天", now)
    assert end == int(now.timestamp())
    assert start < end

    start, end = parse_time_range("昨天", now)
    # 昨天是整天 00:00:00 - 23:59:59
    assert end - start == 86399


def test_relative_time_range_today_9_to_10() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)
    start, end = parse_time_range("今天9:00到10:00", now)
    # 左闭右开
    assert end - start == 3600


def test_absolute_date() -> None:
    start, end = parse_time_range("2026-11-17")
    assert end - start == 86399


def test_absolute_datetime_range() -> None:
    start, end = parse_time_range("2026-11-17 09:00到10:00")
    assert end - start == 3600


def test_absolute_datetime_range_with_english_to_and_seconds() -> None:
    """Agent 常见写法：两端完整日期时间 + 秒 + 英文 to。"""
    start, end = parse_time_range("2026-11-11 07:00:00 to 2026-11-11 07:40:00")
    assert end - start == 40 * 60
    expected_start = int(datetime(2026, 11, 11, 7, 0, 0).timestamp())
    expected_end = int(datetime(2026, 11, 11, 7, 40, 0).timestamp())
    assert start == expected_start
    assert end == expected_end


def test_absolute_datetime_range_agent_variants() -> None:
    """兼容 to/~、可选秒、两端完整日期或仅结束 HH:MM。"""
    baseline = parse_time_range("2026-11-11 07:00-07:40")
    assert baseline is not None
    variants = [
        "2026-11-11 07:00:00到07:40:00",
        "2026-11-11 07:00 to 07:40",
        "2026-11-11 07:00~07:40",
        "2026-11-11 07:00:00 - 2026-11-11 07:40:00",
        "2026-11-11 07:00:00至2026-11-11 07:40:00",
    ]
    for text in variants:
        parsed = parse_time_range(text)
        assert parsed == baseline, text


def test_relative_day_range_with_english_to_and_seconds() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)
    start, end = parse_time_range("今天7:00:00 to 7:40:00", now)
    assert end - start == 40 * 60


def test_past_n_days() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)
    start, end = parse_time_range("过去3天", now)
    assert end == int(now.timestamp())


def test_this_week() -> None:
    now = datetime(2026, 11, 17, 15, 30, 0)  # 周二
    start, end = parse_time_range("本周", now)
    assert end == int(now.timestamp())
    # 周一 00:00:00
    from datetime import timedelta

    monday = now - timedelta(days=1)
    assert start == int(monday.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


def test_invalid_returns_none() -> None:
    assert parse_time_range("not a time") is None
    assert parse_time_range("") is None
    assert parse_time_range(None) is None  # type: ignore[arg-type]
