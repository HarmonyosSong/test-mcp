"""工具错误体系。

按方案 5.3.1：失败工具统一返回 `isError: true` + `content[0].text` 为 JSON 字符串：
`{"error":{"code","message","upstream"?}}`。

实现方式：自定义 `LogMcpToolError`，其 `__str__` 返回该 JSON；
`LogMcpServer.call_tool` 重写捕获 SDK 包装的 `ToolError`，取 `__cause__` 后产出 `CallToolResult`。
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.mcpserver.exceptions import ToolError as SdkToolError
from mcp.types import CallToolResult, TextContent

# 错误码集合，对齐方案 5.3.1
ERROR_CODES = frozenset({"auth", "permission", "bad_request", "upstream", "timeout", "internal"})


class LogMcpToolError(SdkToolError):
    """工具主动抛出的错误；__str__ 返回方案约定的 JSON。"""

    def __init__(
        self,
        code: str,
        message: str,
        upstream: dict[str, Any] | None = None,
    ) -> None:
        if code not in ERROR_CODES:
            code = "internal"
        self.code = code
        self.message = message
        self.upstream = upstream
        super().__init__(self._text())

    def _text(self) -> str:
        payload: dict[str, Any] = {"error": {"code": self.code, "message": self.message}}
        if self.upstream is not None:
            payload["error"]["upstream"] = self.upstream
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    def __str__(self) -> str:  # SDK 用 str(exc) 作为 text content
        return self._text()


def internal_error(message: str = "internal error") -> LogMcpToolError:
    """未捕获异常的兜底错误。"""
    return LogMcpToolError("internal", message)


def make_error_result(text: str) -> CallToolResult:
    """构造 isError=true 的 CallToolResult。"""
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)
