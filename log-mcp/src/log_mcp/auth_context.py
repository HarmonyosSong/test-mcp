"""请求级鉴权上下文。

`BearerAuthDispatcher` 校验 access_token 后写入 client_id / scope；
工具通过 `require_scope` 读取并按方案 5.3.2 强制 scope。

用 contextvars 而非 ASGI scope state，是因为 MCP SDK 的工具执行不在 ASGI 请求栈里，
contextvars 能跨 await 边界稳定传递。
"""

from __future__ import annotations

from contextvars import ContextVar

from log_mcp.errors import LogMcpToolError

# 当前请求的 client_id 与已授予 scope（空格分隔字符串）
CLIENT_ID: ContextVar[str | None] = ContextVar("log_mcp_client_id", default=None)
CLIENT_SCOPE: ContextVar[str | None] = ContextVar("log_mcp_client_scope", default=None)

# 仅需 logs:probe 即可调用的工具白名单（其余工具需 logs:read）
PROBE_ONLY_TOOLS = frozenset({"cloud_probe", "list_services", "get_fields"})


def require_scope(tool_name: str) -> str:
    """按工具维度强制 scope；返回当前 client_id。

    - `logs:read` 可调全部 14 个工具
    - `logs:probe` 仅可调 `cloud_probe` / `list_services` / `get_fields`
    - 无任何授权上下文 → auth 错误
    - scope 不足 → permission 错误
    """
    scope = CLIENT_SCOPE.get()
    if scope is None:
        raise LogMcpToolError("auth", "no authenticated context")
    granted = set(scope.split())
    if "logs:read" in granted:
        return CLIENT_ID.get() or ""
    if tool_name in PROBE_ONLY_TOOLS and "logs:probe" in granted:
        return CLIENT_ID.get() or ""
    raise LogMcpToolError(
        "permission",
        f"missing required scope for tool {tool_name}",
    )
