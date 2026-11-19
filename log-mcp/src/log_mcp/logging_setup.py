"""日志装配：控制台 + 数据目录按「轮次」实时切分落盘。

两条落盘线：

1. **轮次文件（主）**：`<data_root>/logs/log-mcp-round-YYYY-MM-DD_HH-MM-SS.log`
   - 一轮问答 = 一个文件，文件名是这一轮的开始时刻（秒级粒度）。
   - Runtime 建立本轮 log-mcp 连接时用 HTTP 头 `X-Odyssey-Round-Start` 传开始时间；
     log-mcp 收到该轮第一条日志时**立即建文件**，本轮后续的工具调用、上游 HTTP
     日志全部追加进同一文件，不会混进别的轮次。
   - 同一秒内两轮问答：顺延 `_02`、`_03`，互不覆盖。
   - 文件名天然可排序：`ls logs/log-mcp-round-*` 的字典序即轮次先后顺序。

2. **进程文件（兜底）**：`<data_root>/logs/log-mcp-YYYY-MM-DD_HH-MM-SS.log`
   - 没有轮次上下文的日志（进程启动、关闭、外部直连调试）写这里；
     一次进程启动一个文件，跨零点不切。

同时保留控制台输出便于前台/容器看 stdout。
"""

from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import IO, NamedTuple

# 会话时间戳格式：年月日_时分秒（例：2026-11-19_15-28-12）
SESSION_TS_FORMAT = "%Y-%m-%d_%H-%M-%S"
# 同一秒内的最大序号（99 之后放弃，直接报错，避免无限循环）
MAX_SESSION_SEQ = 99
# 轮次文件的类型标记：`log-mcp-round-2026-11-19_15-50-20.log`
ROUND_KIND = "round"
# 同时保持打开的轮次文件上限；超出后关闭最久未写的（文件保留，下次追加重新打开）
MAX_OPEN_ROUND_FILES = 32

# ---- 轮次上下文（由 HTTP 中间件写入，日志 handler 读取） ----
# 本轮开始时刻（epoch 毫秒）；None 表示当前日志不属于任何轮次
ROUND_START_MS: ContextVar[int | None] = ContextVar("log_mcp_round_start_ms", default=None)
# 本轮标识（如 `run=run-xxx conv=conv-yyy`），只写进文件头注释，不进文件名
ROUND_LABEL: ContextVar[str | None] = ContextVar("log_mcp_round_label", default=None)


def session_filename(
    prefix: str,
    start: datetime,
    *,
    seq: int = 1,
    suffix: str = ".log",
    kind: str = "",
) -> str:
    """生成日志文件名。

    `seq=1` → `log-mcp-2026-11-19_15-28-12.log`
    `seq=2` → `log-mcp-2026-11-19_15-28-12_02.log`
    `kind="round"` → `log-mcp-round-2026-11-19_15-28-12.log`

    序号用下划线连接而非连字符：`_`(0x5F) 排在 `.`(0x2E) 之后，
    这样字典序严格等于会话先后顺序（连字符 0x2D 会排到 `.` 之前，导致乱序）。
    """
    stamp = start.strftime(SESSION_TS_FORMAT)
    stem = f"{prefix}-{kind}-{stamp}" if kind else f"{prefix}-{stamp}"
    if seq <= 1:
        return f"{stem}{suffix}"
    return f"{stem}_{seq:02d}{suffix}"


class _CreatedFile(NamedTuple):
    path: Path
    stream: IO[str]


class SessionFileHandler(logging.Handler):
    """按轮次实时切分的文件 handler。

    - 构造时先建好进程兜底文件（`log-mcp-YYYY-MM-DD_HH-MM-SS.log`），保证启动日志不丢。
    - 每条日志按当前轮次上下文决定落哪个文件；轮次文件在第一条日志时按需创建，
      因此「问答 15:50:20 开始」就得到 `log-mcp-round-2026-11-19_15-50-20.log`。
    - 文件权限 0600，独占创建（同秒并发也不覆盖）。
    """

    def __init__(
        self,
        log_dir: Path,
        *,
        prefix: str = "log-mcp",
        start: datetime | None = None,
        max_open_rounds: int = MAX_OPEN_ROUND_FILES,
    ) -> None:
        super().__init__()
        self._log_dir = Path(log_dir)
        self._prefix = prefix
        self._start = start or datetime.now()
        self._max_open_rounds = max(1, max_open_rounds)
        self._lock = threading.Lock()
        # 轮次 key → 文件路径（永久记住，避免同一轮重复建 `_02` 文件）
        self._round_paths: dict[tuple[int, str | None], Path] = {}
        # 当前打开的轮次文件（LRU，只关流不删文件）
        self._open_rounds: OrderedDict[tuple[int, str | None], IO[str]] = OrderedDict()
        self._boot: _CreatedFile = self._create_file(kind="", start=self._start)

    # ---- 对外只读信息 ----

    @property
    def path(self) -> Path:
        """进程兜底日志文件路径（启动日志打印用）。"""
        return self._boot.path

    @property
    def round_paths(self) -> list[Path]:
        """已创建的全部轮次文件（按创建顺序）。"""
        return list(self._round_paths.values())

    # ---- 文件创建 ----

    def _create_file(self, *, kind: str, start: datetime, suffix: str = ".log") -> _CreatedFile:
        """独占创建一个新日志文件；重名顺延序号。"""
        self._log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        seq = 1
        while True:
            path = self._log_dir / session_filename(
                self._prefix,
                start,
                seq=seq,
                suffix=suffix,
                kind=kind,
            )
            try:
                # O_EXCL：同秒并发也不会互相覆盖
                fd = os.open(
                    path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND,
                    0o600,
                )
            except FileExistsError:
                seq += 1
                if seq > MAX_SESSION_SEQ:
                    raise
                continue
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass  # 权限尽力而为（某些文件系统不支持）
            return _CreatedFile(path, os.fdopen(fd, "a", encoding="utf-8"))  # noqa: SIM115

    def _round_stream(self, start_ms: int, label: str | None) -> IO[str]:
        """取（必要时创建）本轮日志文件流。调用方需持有 self._lock。"""
        key = (start_ms, label)
        opened = self._open_rounds.get(key)
        if opened is not None:
            self._open_rounds.move_to_end(key)
            return opened

        path = self._round_paths.get(key)
        if path is None:
            path = self._existing_round_path(start_ms, label)
        if path is None:
            start = datetime.fromtimestamp(start_ms / 1000)
            created = self._create_file(kind=ROUND_KIND, start=start)
            path = created.path
            stream = created.stream
            self._round_paths[key] = path
            # 文件头注释：人肉翻查时能确认这是哪一轮，不与日志行格式混排
            stamp = start.strftime("%Y-%m-%d %H:%M:%S")
            stream.write(f"# ===== round {stamp}{f' {label}' if label else ''} =====\n")
            stream.flush()
        else:
            # 之前被 LRU 关掉过，或进程重启后接续同一轮：以追加方式打开原文件
            self._round_paths[key] = path
            stream = open(path, "a", encoding="utf-8")  # noqa: SIM115

        self._open_rounds[key] = stream
        while len(self._open_rounds) > self._max_open_rounds:
            _, stale = self._open_rounds.popitem(last=False)
            try:
                stale.close()
            except OSError:
                pass
        return stream

    def _existing_round_path(self, start_ms: int, label: str | None) -> Path | None:
        """磁盘上已存在同一轮的日志文件时复用它（进程重启后接续同一轮）。

        只认带轮次标识的文件头，避免误并到别的同秒轮次。
        """
        if not label:
            return None
        start = datetime.fromtimestamp(start_ms / 1000)
        for seq in range(1, MAX_SESSION_SEQ + 1):
            candidate = self._log_dir / session_filename(
                self._prefix,
                start,
                seq=seq,
                kind=ROUND_KIND,
            )
            if not candidate.is_file():
                # 序号连续分配，遇到不存在的即可停
                return None
            if self._file_belongs_to_round(candidate, label):
                return candidate
        return None

    @staticmethod
    def _file_belongs_to_round(path: Path, label: str) -> bool:
        """读首行文件头判断归属；只读一小段，避免大文件全量加载。"""
        try:
            with open(path, encoding="utf-8") as stream:  # noqa: SIM115
                head = stream.readline()
        except OSError:
            return False
        return head.startswith("# ===== round ") and label in head

    # ---- logging.Handler ----

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            with self._lock:
                start_ms = ROUND_START_MS.get()
                if start_ms is None:
                    stream = self._boot.stream
                else:
                    stream = self._round_stream(start_ms, ROUND_LABEL.get())
                stream.write(msg + "\n")
                stream.flush()
        except Exception:  # noqa: BLE001 — logging handler 不能再抛
            self.handleError(record)

    def close(self) -> None:
        with self._lock:
            for stream in [self._boot.stream, *self._open_rounds.values()]:
                try:
                    stream.close()
                except OSError:
                    pass
            self._open_rounds.clear()
        super().close()


def setup_logging(
    log_dir: Path,
    *,
    level: int = logging.INFO,
    prefix: str = "log-mcp",
    start: datetime | None = None,
) -> Path:
    """配置根 logger：控制台 + 按轮次实时切分的文件。

    返回进程兜底日志文件路径（便于启动时打印）。
    """
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )

    root = logging.getLogger()
    root.setLevel(level)
    # 避免重复 basicConfig / 多次 setup 叠加 handler
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.setLevel(level)
    root.addHandler(console)

    file_handler = SessionFileHandler(log_dir, prefix=prefix, start=start)
    file_handler.setFormatter(formatter)
    file_handler.setLevel(level)
    root.addHandler(file_handler)

    return file_handler.path
