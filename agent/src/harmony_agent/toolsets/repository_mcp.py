from __future__ import annotations

from pathlib import Path

from harmony_repo_mcp import create_mcp_server
from pydantic_ai.mcp import MCPToolset


def build_chat_repository_toolset(workspace_path: str | None) -> MCPToolset | None:
    """MCP errors are handled by the turn-wide BudgetedToolset wrapper."""
    if not workspace_path:
        return None
    return MCPToolset(
        create_mcp_server(Path(workspace_path)),
        tool_error_behavior="retry",
    )
