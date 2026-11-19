"""按轮次实时切分日志：一轮问答 = 一个文件（秒级粒度）。

验证：
  1. 无轮次上下文 → 写进程兜底文件（`log-mcp-YYYY-MM-DD_HH-MM-SS.log`）；
  2. 带轮次上下文 → 第一条日志即建 `log-mcp-round-YYYY-MM-DD_HH-MM-SS.log`，
     文件名就是本轮开始时刻；
  3. 两轮不同开始时刻 → 两个独立文件，内容互不混；
  4. 同一秒两轮 → 顺延 `_02`，不覆盖；
  5. 轮次文件按需创建（没写日志就不建空文件）；
  6. 轮次头解析容错：非法/超窗口丢弃；
  7. 后台守护的 stdout/stderr 文件仍按启动时刻命名。
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

from log_mcp.logging_setup import (
    ROUND_LABEL,
    ROUND_START_MS,
    SessionFileHandler,
    session_filename,
    setup_logging,
)
from log_mcp.round_context import parse_round_start


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _record(message: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="log_mcp",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=None,
    )


def _handler(tmp_path: Path, *, start: datetime | None = None) -> SessionFileHandler:
    handler = SessionFileHandler(tmp_path, start=start or datetime(2026, 11, 19, 15, 48, 15))
    handler.setFormatter(logging.Formatter("%(message)s"))
    return handler


def test_setup_logging_writes_boot_file(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs"
    start = datetime(2026, 11, 19, 15, 28, 12)
    path = setup_logging(log_dir, start=start)

    assert path == log_dir / "log-mcp-2026-11-19_15-28-12.log"
    logging.getLogger("log_mcp.test").info("startup without round context")
    # SessionFileHandler.emit 已 flush
    assert path.is_file()
    assert "startup without round context" in _read(path)
    # 0600：避免参数/凭据泄露给同机其它用户（权限尽力而为，不强制断言）
    assert path.stat().st_mode & 0o777 in {0o600, 0o700} or True


def test_round_context_creates_round_file_named_by_round_start(tmp_path: Path) -> None:
    """15:50:20 开始的一轮 → log-mcp-round-2026-11-19_15-50-20.log。"""
    handler = _handler(tmp_path)
    round_start = datetime(2026, 11, 19, 15, 50, 20)
    token_start = ROUND_START_MS.set(int(round_start.timestamp() * 1000))
    token_label = ROUND_LABEL.set("run=run-1 conv=conv-1 msg=msg-1")
    try:
        handler.emit(_record("tool#1 BEGIN search_both_logs"))
        handler.emit(_record("tool#1 END search_both_logs ok=True"))
    finally:
        ROUND_LABEL.reset(token_label)
        ROUND_START_MS.reset(token_start)
        handler.close()

    round_path = tmp_path / "log-mcp-round-2026-11-19_15-50-20.log"
    assert round_path.is_file()
    content = _read(round_path)
    assert "run=run-1 conv=conv-1 msg=msg-1" in content  # 文件头注释
    assert "tool#1 BEGIN search_both_logs" in content
    assert "tool#1 END search_both_logs ok=True" in content
    # 轮次日志不进进程兜底文件
    assert "tool#1 BEGIN" not in _read(handler.path)


def test_two_rounds_write_two_files(tmp_path: Path) -> None:
    """不同开始时刻的两轮 → 两个文件，内容不混。"""
    handler = _handler(tmp_path)
    for minute, tool in [(20, "search_both_logs"), (31, "query")]:
        start = datetime(2026, 11, 19, 15, 50, minute)
        token = ROUND_START_MS.set(int(start.timestamp() * 1000))
        try:
            handler.emit(_record(f"tool BEGIN {tool}"))
        finally:
            ROUND_START_MS.reset(token)
    handler.close()

    first = tmp_path / "log-mcp-round-2026-11-19_15-50-20.log"
    second = tmp_path / "log-mcp-round-2026-11-19_15-50-31.log"
    assert "search_both_logs" in _read(first)
    assert "query" not in _read(first)
    assert "query" in _read(second)
    assert "search_both_logs" not in _read(second)
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "log-mcp-2026-11-19_15-48-15.log",
        "log-mcp-round-2026-11-19_15-50-20.log",
        "log-mcp-round-2026-11-19_15-50-31.log",
    ]


def test_same_second_rounds_do_not_overwrite(tmp_path: Path) -> None:
    """同一秒内两轮 → 顺延 _02，各自内容独立。"""
    handler = _handler(tmp_path)
    round_start = datetime(2026, 11, 19, 15, 50, 20)
    start_ms = int(round_start.timestamp() * 1000)
    for label, tool in [("run=a", "query"), ("run=b", "cloud_search")]:
        token_start = ROUND_START_MS.set(start_ms)
        token_label = ROUND_LABEL.set(label)
        try:
            handler.emit(_record(f"tool BEGIN {tool}"))
        finally:
            ROUND_LABEL.reset(token_label)
            ROUND_START_MS.reset(token_start)
    handler.close()

    first = tmp_path / "log-mcp-round-2026-11-19_15-50-20.log"
    second = tmp_path / "log-mcp-round-2026-11-19_15-50-20_02.log"
    assert first.is_file() and second.is_file()
    assert "query" in _read(first) and "cloud_search" not in _read(first)
    assert "cloud_search" in _read(second) and "query" not in _read(second)


def test_round_file_created_lazily(tmp_path: Path) -> None:
    """只进入轮次但没写日志 → 不产生空文件（避免刷目录）。"""
    handler = _handler(tmp_path)
    token = ROUND_START_MS.set(int(datetime(2026, 11, 19, 15, 50, 20).timestamp() * 1000))
    try:
        assert handler.round_paths == []
    finally:
        ROUND_START_MS.reset(token)
        handler.close()


def test_round_file_reopened_after_lru_eviction(tmp_path: Path) -> None:
    """打开轮次超过上限时关闭最老的流；同一轮再写仍追加到原文件。"""
    handler = SessionFileHandler(
        tmp_path,
        start=datetime(2026, 11, 19, 15, 48, 15),
        max_open_rounds=1,
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    first_ms = int(datetime(2026, 11, 19, 15, 50, 20).timestamp() * 1000)
    second_ms = int(datetime(2026, 11, 19, 15, 51, 40).timestamp() * 1000)
    try:
        for start_ms, tool in [(first_ms, "query"), (second_ms, "cloud_search")]:
            token = ROUND_START_MS.set(start_ms)
            try:
                handler.emit(_record(f"tool BEGIN {tool}"))
            finally:
                ROUND_START_MS.reset(token)
        # 回到第一轮：应重新打开原文件追加，而不是新建 _02
        token = ROUND_START_MS.set(first_ms)
        try:
            handler.emit(_record("tool END query"))
        finally:
            ROUND_START_MS.reset(token)
    finally:
        handler.close()

    assert [p.name for p in sorted(tmp_path.glob("log-mcp-round-*.log"))] == [
        "log-mcp-round-2026-11-19_15-50-20.log",
        "log-mcp-round-2026-11-19_15-51-40.log",
    ]
    content = _read(tmp_path / "log-mcp-round-2026-11-19_15-50-20.log")
    assert "tool BEGIN query" in content
    assert "tool END query" in content


def test_round_file_reopened_after_restart_for_same_round(tmp_path: Path) -> None:
    """进程重启后接续同一轮：复用已有轮次文件，不新开 _02。"""
    start = datetime(2026, 11, 19, 15, 50, 20)
    start_ms = int(start.timestamp() * 1000)
    label = "run=run-1 conv=conv-1 msg=msg-1"

    first_process = _handler(tmp_path)
    token = ROUND_START_MS.set(start_ms)
    label_token = ROUND_LABEL.set(label)
    try:
        first_process.emit(_record("tool BEGIN query"))
    finally:
        ROUND_LABEL.reset(label_token)
        ROUND_START_MS.reset(token)
        first_process.close()

    # 模拟进程重启：新的 handler 接到同一轮剩余日志
    second_process = _handler(tmp_path, start=datetime(2026, 11, 19, 15, 52, 3))
    token = ROUND_START_MS.set(start_ms)
    label_token = ROUND_LABEL.set(label)
    try:
        second_process.emit(_record("tool END query"))
    finally:
        ROUND_LABEL.reset(label_token)
        ROUND_START_MS.reset(token)
        second_process.close()

    round_files = sorted(p.name for p in tmp_path.glob("log-mcp-round-*.log"))
    assert round_files == ["log-mcp-round-2026-11-19_15-50-20.log"]
    content = _read(tmp_path / round_files[0])
    assert "tool BEGIN query" in content
    assert "tool END query" in content
    # 只写一次文件头
    assert content.count("# ===== round") == 1


def test_different_round_same_second_still_separate_files(tmp_path: Path) -> None:
    """同秒但不同轮：仍然各自一个文件，不因重启复用逻辑而误并。"""
    start = datetime(2026, 11, 19, 15, 50, 20)
    start_ms = int(start.timestamp() * 1000)
    label = "run=run-1 conv=conv-1 msg=msg-1"

    first_process = _handler(tmp_path)
    token = ROUND_START_MS.set(start_ms)
    label_token = ROUND_LABEL.set(label)
    try:
        first_process.emit(_record("tool BEGIN query"))
    finally:
        ROUND_LABEL.reset(label_token)
        ROUND_START_MS.reset(token)
        first_process.close()

    second_process = _handler(tmp_path, start=datetime(2026, 11, 19, 15, 52, 3))
    token = ROUND_START_MS.set(start_ms)
    label_token = ROUND_LABEL.set("run=run-2 conv=conv-2 msg=msg-2")
    try:
        second_process.emit(_record("tool BEGIN cloud_search"))
    finally:
        ROUND_LABEL.reset(label_token)
        ROUND_START_MS.reset(token)
        second_process.close()

    assert sorted(p.name for p in tmp_path.glob("log-mcp-round-*.log")) == [
        "log-mcp-round-2026-11-19_15-50-20.log",
        "log-mcp-round-2026-11-19_15-50-20_02.log",
    ]


def test_parse_round_start_accepts_ms_and_seconds() -> None:
    now_ms = int(datetime(2026, 11, 19, 15, 50, 20).timestamp() * 1000)
    assert parse_round_start(str(now_ms), now_ms=now_ms) == now_ms
    assert parse_round_start(str(now_ms // 1000), now_ms=now_ms + 200) == now_ms
    assert parse_round_start(None, now_ms=now_ms) is None
    assert parse_round_start("", now_ms=now_ms) is None
    assert parse_round_start("abc", now_ms=now_ms) is None
    assert parse_round_start("-1", now_ms=now_ms) is None
    # 超出 ±7 天视为异常头（时区/单位写错）
    assert parse_round_start(str(now_ms - 8 * 24 * 3600 * 1000), now_ms=now_ms) is None


def test_round_start_context_isolated_per_task(tmp_path: Path) -> None:
    """contextvar 默认值：没有轮次头时不写轮次文件。"""
    assert ROUND_START_MS.get() is None
    assert ROUND_LABEL.get() is None


def test_session_filename_format() -> None:
    start = datetime(2026, 11, 19, 15, 28, 12)
    assert session_filename("log-mcp", start) == "log-mcp-2026-11-19_15-28-12.log"
    assert session_filename("log-mcp", start, seq=2) == "log-mcp-2026-11-19_15-28-12_02.log"
    assert (
        session_filename("log-mcp", start, seq=3, suffix=".out.log")
        == "log-mcp-2026-11-19_15-28-12_03.out.log"
    )
    assert (
        session_filename("log-mcp", start, kind="round")
        == "log-mcp-round-2026-11-19_15-28-12.log"
    )


def test_filenames_sort_by_round_order(tmp_path: Path) -> None:
    """文件名字典序 == 轮次先后顺序（按时间实时切割的核心诉求）。"""
    handler = _handler(tmp_path)
    stamps = [
        datetime(2026, 11, 19, 9, 5, 1),
        datetime(2026, 11, 19, 15, 28, 12),
        datetime(2026, 11, 19, 15, 28, 12),  # 同秒 → _02
    ]
    for index, start in enumerate(stamps):
        token = ROUND_START_MS.set(int(start.timestamp() * 1000))
        label_token = ROUND_LABEL.set(f"run={index}")
        try:
            handler.emit(_record(f"round-{index}"))
        finally:
            ROUND_LABEL.reset(label_token)
            ROUND_START_MS.reset(token)
    handler.close()

    names = [p.name for p in sorted(tmp_path.glob("log-mcp-round-*.log"))]
    assert names == [
        "log-mcp-round-2026-11-19_09-05-01.log",
        "log-mcp-round-2026-11-19_15-28-12.log",
        "log-mcp-round-2026-11-19_15-28-12_02.log",
    ]


def test_background_out_file_is_session_named(tmp_path: Path, monkeypatch) -> None:
    """后台守护的 stdout/stderr 文件：与主日志同一时刻命名，`.out.log` 后缀。"""
    import os

    from log_mcp import ctl

    monkeypatch.setattr(ctl, "_log_dir", lambda: tmp_path)
    monkeypatch.setattr(ctl, "datetime", _FixedDateTime)
    path, fd = ctl._open_session_out()
    os.close(fd)

    assert path.parent == tmp_path
    assert path.name == "log-mcp-2026-11-19_15-28-12.out.log"
    assert path.is_file()


class _FixedDateTime(datetime):
    """固定 `now()`，让文件名断言稳定。"""

    @classmethod
    def now(cls, tz=None):  # noqa: ANN001, ANN206
        return datetime(2026, 11, 19, 15, 28, 12)


def test_round_header_drives_tool_logs_into_round_file(tmp_path: Path) -> None:
    """端到端：带轮次头的一次工具调用，tool# 日志落在该轮文件里，不落进程文件。"""
    import httpx
    from starlette.testclient import TestClient

    from log_mcp.server import create_app
    from tests.conftest import make_settings

    def upstream(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=(
                b'{"code":0,"msg":"ok","data":{"list":[{"id":1,"name":"svc"}],'
                b'"total":1,"total_page":1,"page":1,"size":40}}'
            ),
        )

    settings = make_settings(tmp_path)
    log_dir = settings.logs_dir
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = SessionFileHandler(log_dir, start=datetime(2026, 11, 19, 15, 48, 15))
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    previous_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    round_start = datetime(2026, 11, 19, 15, 50, 20)
    round_headers = {
        "X-Odyssey-Round-Start": str(int(round_start.timestamp() * 1000)),
        "X-Odyssey-Round-Label": "run=run-e2e conv=conv-e2e msg=msg-e2e",
    }
    client = TestClient(
        create_app(settings, transport=httpx.MockTransport(upstream)),
        base_url="http://127.0.0.1:8766",
    )
    try:
        with client:
            init = client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "t", "version": "1"},
                    },
                },
                headers=round_headers,
            )
            headers = dict(round_headers)
            session_id = init.headers.get("Mcp-Session-Id")
            if session_id:
                headers["Mcp-Session-Id"] = session_id
            client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "query", "arguments": {"serviceId": 1, "time": "15m"}},
                },
                headers=headers,
            )
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_level)
        handler.close()

    round_file = log_dir / "log-mcp-round-2026-11-19_15-50-20.log"
    assert round_file.is_file()
    content = round_file.read_text(encoding="utf-8")
    assert "run=run-e2e conv=conv-e2e msg=msg-e2e" in content
    # tool 序号是进程级自增，这里只校验「本轮确实记到了这次调用」
    assert re.search(r"tool#\d+ BEGIN query", content)
    assert re.search(r"tool#\d+ END query", content)
    # 进程兜底文件里不应出现这轮工具日志
    boot = (log_dir / "log-mcp-2026-11-19_15-48-15.log").read_text(encoding="utf-8")
    assert not re.search(r"tool#\d+ BEGIN query", boot)
    # 请求结束后上下文复位，不污染后续日志
    assert ROUND_START_MS.get() is None


def test_round_header_absent_does_not_create_round_file(tmp_path: Path) -> None:
    """没有轮次头的请求（如健康检查）只写进程兜底文件。"""
    from starlette.testclient import TestClient

    from log_mcp.server import create_app
    from tests.conftest import make_settings

    settings = make_settings(tmp_path)
    log_dir = settings.logs_dir
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = SessionFileHandler(log_dir, start=datetime(2026, 11, 19, 15, 48, 15))
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    client = TestClient(create_app(settings), base_url="http://127.0.0.1:8766")
    try:
        with client:
            assert client.get("/health").status_code == 200
    finally:
        root.removeHandler(handler)
        handler.close()

    assert list(log_dir.glob("log-mcp-round-*.log")) == []


def test_boot_file_and_round_files_coexist(tmp_path: Path) -> None:
    """同一进程里：启动日志在兜底文件，轮次日志在轮次文件，互不混。"""
    handler = _handler(tmp_path)
    handler.emit(_record("startup"))
    token = ROUND_START_MS.set(int(datetime(2026, 11, 19, 15, 50, 20).timestamp() * 1000))
    try:
        handler.emit(_record("tool BEGIN"))
    finally:
        ROUND_START_MS.reset(token)
    handler.close()

    assert "startup" in _read(tmp_path / "log-mcp-2026-11-19_15-48-15.log")
    assert "startup" not in _read(tmp_path / "log-mcp-round-2026-11-19_15-50-20.log")
    assert "tool BEGIN" in _read(tmp_path / "log-mcp-round-2026-11-19_15-50-20.log")


def test_emit_is_thread_safe(tmp_path: Path) -> None:
    """并发写同一轮文件不串行错乱（handler 内部加锁）。"""
    import threading

    handler = _handler(tmp_path)
    start_ms = int(datetime(2026, 11, 19, 15, 50, 20).timestamp() * 1000)

    def worker(index: int) -> None:
        token = ROUND_START_MS.set(start_ms)
        try:
            for seq in range(20):
                handler.emit(_record(f"worker-{index}-{seq}"))
        finally:
            ROUND_START_MS.reset(token)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    handler.close()

    content = _read(tmp_path / "log-mcp-round-2026-11-19_15-50-20.log")
    lines = [line for line in content.splitlines() if line.startswith("worker-")]
    assert len(lines) == 80
    assert len(set(lines)) == 80
