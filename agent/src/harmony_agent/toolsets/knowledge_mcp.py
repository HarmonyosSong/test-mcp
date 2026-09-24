from pathlib import Path

from harmony_knowledge_mcp.server import create_knowledge_server
from pydantic_ai.mcp import MCPToolset


def build_knowledge_toolset(
    root: Path, query_log_path: str | None = None, *, query_context: dict[str, str] | None = None
) -> MCPToolset:
    """Reuse the knowledge server so symptom questions are available in both agent paths."""
    return MCPToolset(
        create_knowledge_server(root, query_log_path=query_log_path, query_context=query_context),
        tool_error_behavior="retry",
    )
