from __future__ import annotations

from pathlib import Path
from time import perf_counter
from typing import Any

from harmony_repo_mcp import create_mcp_server
from pydantic_ai import RunContext
from pydantic_ai.mcp import CallToolFunc, MCPToolset, ToolResult

from ..domain import DiagnosisCase, ToolEvent


def build_repository_toolset(case: DiagnosisCase) -> MCPToolset | None:
    if not case.workspace_path:
        return None

    async def audit_tool_call(
        _ctx: RunContext[Any],
        call_tool: CallToolFunc,
        name: str,
        arguments: dict[str, Any],
    ) -> ToolResult:
        started = perf_counter()
        try:
            result = await call_tool(name, arguments)
        except Exception as exc:
            case.tool_events.append(
                ToolEvent(
                    tool=name,
                    status="failed",
                    summary=f"MCP 调用失败：{type(exc).__name__}",
                )
            )
            raise
        duration_ms = max(1, round((perf_counter() - started) * 1_000))
        case.tool_events.append(
            ToolEvent(
                tool=name,
                status="completed",
                summary=f"MCP 调用完成，耗时 {duration_ms} ms",
            )
        )
        return result

    return MCPToolset(
        create_mcp_server(Path(case.workspace_path)),
        tool_error_behavior="failed",
        process_tool_call=audit_tool_call,
    )


def build_chat_repository_toolset(workspace_path: str | None) -> MCPToolset | None:
    """聊天路径的只读 MCP 工具集。

    与案例诊断路径的差异：
    - 不挂 process_tool_call 审计钩子——聊天步骤由 run_stream_events 的
      FunctionToolCall/Result 事件产生，避免重复记账。
    - tool_error_behavior 使用 retry，工具错误以 ModelRetry 回给模型如实转述，
      而不是中止整轮对话。
    """
    if not workspace_path:
        return None
    return MCPToolset(
        create_mcp_server(Path(workspace_path)),
        tool_error_behavior="retry",
    )
