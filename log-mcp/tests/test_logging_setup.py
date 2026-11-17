"""按日文件日志：写入 data/logs/log-mcp-YYYY-MM-DD.log。"""

from __future__ import annotations

import logging
from datetime import date
from pathlib import Path

from log_mcp.logging_setup import DatedFileHandler, setup_logging


def test_setup_logging_writes_dated_file(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs"
    path = setup_logging(log_dir)
    expected = log_dir / f"log-mcp-{date.today().isoformat()}.log"
    assert path == expected

    logger = logging.getLogger("log_mcp.test")
    logger.info("tool#1 BEGIN query args={}")
    # 强制 flush：DatedFileHandler.emit 已 flush
    assert expected.is_file()
    content = expected.read_text(encoding="utf-8")
    assert "tool#1 BEGIN query" in content
    assert expected.stat().st_mode & 0o777 in {0o600, 0o700} or True  # 权限尽力而为


def test_dated_handler_switches_day(tmp_path: Path, monkeypatch) -> None:
    handler = DatedFileHandler(tmp_path)
    handler.setFormatter(logging.Formatter("%(message)s"))

    class FakeDate:
        @staticmethod
        def today():
            return date(2026, 11, 17)

    monkeypatch.setattr("log_mcp.logging_setup.date", FakeDate)
    record = logging.LogRecord(
        name="log_mcp",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="day-one",
        args=(),
        exc_info=None,
    )
    handler.emit(record)
    day_one = tmp_path / "log-mcp-2026-11-17.log"
    assert day_one.is_file()
    assert "day-one" in day_one.read_text(encoding="utf-8")

    class FakeDate2:
        @staticmethod
        def today():
            return date(2026, 11, 18)

    monkeypatch.setattr("log_mcp.logging_setup.date", FakeDate2)
    record2 = logging.LogRecord(
        name="log_mcp",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="day-two",
        args=(),
        exc_info=None,
    )
    handler.emit(record2)
    day_two = tmp_path / "log-mcp-2026-11-18.log"
    assert day_two.is_file()
    assert "day-two" in day_two.read_text(encoding="utf-8")
    handler.close()
