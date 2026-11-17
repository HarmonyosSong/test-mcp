"""日志装配：控制台 + data 目录按日文件。

落盘路径：`<data_root>/logs/log-mcp-YYYY-MM-DD.log`
跨日自动切换新文件；同时保留控制台输出便于前台/容器看 stdout。
"""

from __future__ import annotations

import logging
from datetime import date
from pathlib import Path


class DatedFileHandler(logging.Handler):
    """按自然日切换文件的 Handler。

    文件名：`log-mcp-YYYY-MM-DD.log`，目录由构造时传入。
    """

    def __init__(self, log_dir: Path, *, prefix: str = "log-mcp") -> None:
        super().__init__()
        self._log_dir = Path(log_dir)
        self._prefix = prefix
        self._current_day: date | None = None
        self._stream = None
        self._path: Path | None = None

    def _ensure_stream(self) -> None:
        today = date.today()
        if self._stream is not None and self._current_day == today:
            return
        self._close_stream()
        self._log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._path = self._log_dir / f"{self._prefix}-{today.isoformat()}.log"
        # 追加写；0600 避免凭据/调用参数泄露给同机其它用户
        self._stream = open(self._path, "a", encoding="utf-8")  # noqa: SIM115
        try:
            self._path.chmod(0o600)
        except OSError:
            pass
        self._current_day = today

    def _close_stream(self) -> None:
        if self._stream is not None:
            try:
                self._stream.close()
            except OSError:
                pass
            self._stream = None

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._ensure_stream()
            assert self._stream is not None
            msg = self.format(record)
            self._stream.write(msg + "\n")
            self._stream.flush()
        except Exception:  # noqa: BLE001 — logging handler 不能再抛
            self.handleError(record)

    def close(self) -> None:
        try:
            self._close_stream()
        finally:
            super().close()


def setup_logging(log_dir: Path, *, level: int = logging.INFO) -> Path:
    """配置 `log_mcp` logger：控制台 + 按日文件。

    返回当天日志文件路径（便于启动时打印）。
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

    file_handler = DatedFileHandler(log_dir)
    file_handler.setFormatter(formatter)
    file_handler.setLevel(level)
    root.addHandler(file_handler)

    today_path = log_dir / f"log-mcp-{date.today().isoformat()}.log"
    return today_path
