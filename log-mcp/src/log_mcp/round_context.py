"""轮次上下文 ASGI 中间件：把「这一轮从什么时候开始」写进 contextvar。

Runtime 每轮诊断都会新建一个 log-mcp 连接，并在请求头里带上：

  `X-Odyssey-Round-Start`: 本轮开始时刻（epoch 毫秒，秒级精度足够）
  `X-Odyssey-Round-Label`: 本轮标识（run/conv/msg），仅用于文件头注释

中间件校验后写入 `ROUND_START_MS` / `ROUND_LABEL`，日志 handler 据此把本轮所有日志
实时写进 `log-mcp-round-YYYY-MM-DD_HH-MM-SS.log`。请求结束即复位，不污染其它请求。

没有头的请求（进程内部日志、外部直连调试）继续写进程兜底文件。
"""

from __future__ import annotations

import time

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from log_mcp.logging_setup import ROUND_LABEL, ROUND_START_MS

ROUND_START_HEADER = "x-odyssey-round-start"
ROUND_LABEL_HEADER = "x-odyssey-round-label"
# 时间头容错窗口：超出 ±7 天视为异常（时区/单位写错），退回进程文件
MAX_CLOCK_SKEW_MS = 7 * 24 * 3600 * 1000
# 文件头里的标识最多保留多少字符，避免超长头把首行撑爆
MAX_LABEL_CHARS = 200


def parse_round_start(raw: str | None, *, now_ms: int | None = None) -> int | None:
    """解析开始时间头；非法/超出容错窗口返回 None。

    接受 13 位毫秒或 10 位秒（秒会×1000），方便手工用 curl 调试。
    """
    if not raw:
        return None
    text = raw.strip()
    if not text.isdigit():
        return None
    value = int(text)
    if value <= 0:
        return None
    # 10 位按秒解释
    if value < 10_000_000_000:
        value *= 1000
    current = now_ms if now_ms is not None else int(time.time() * 1000)
    if abs(current - value) > MAX_CLOCK_SKEW_MS:
        return None
    return value


class RoundContextMiddleware:
    """读取轮次头并注入 contextvar；请求结束复位。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        start_ms = parse_round_start(headers.get(ROUND_START_HEADER))
        if start_ms is None:
            await self.app(scope, receive, send)
            return

        label = (headers.get(ROUND_LABEL_HEADER) or "").strip()[:MAX_LABEL_CHARS] or None
        start_token = ROUND_START_MS.set(start_ms)
        label_token = ROUND_LABEL.set(label)
        try:
            await self.app(scope, receive, send)
        finally:
            ROUND_LABEL.reset(label_token)
            ROUND_START_MS.reset(start_token)
