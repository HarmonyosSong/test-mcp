from __future__ import annotations

from fastmcp import FastMCP

from ..code_index import CodeIndexBackend

CODE_NAVIGATION_TOOL_NAMES = [
    "search_code_symbols",
    "get_code_outline",
    "trace_code_path",
]


def register_code_navigation_tools(server: FastMCP, backend: CodeIndexBackend) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    async def search_code_symbols(
        query: str,
        file_pattern: str = "**/*",
        limit: int = 20,
    ) -> dict:
        """Search the snapshot's optional code graph for symbol/text candidates.

        Results locate code only. Always call read_project_file before treating a
        result as an observed source fact or citing it in a diagnosis report.
        """
        return await backend.search_symbols(query, file_pattern=file_pattern, limit=limit)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    async def get_code_outline(relative_path: str, limit: int = 100) -> dict:
        """List indexed symbols in one snapshot file; this is navigation, not evidence."""
        return await backend.file_outline(relative_path, limit=limit)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    async def trace_code_path(
        function_name: str,
        direction: str = "inbound",
        depth: int = 1,
        limit: int = 20,
    ) -> dict:
        """Find static caller/callee candidates for a symbol in the snapshot."""
        return await backend.trace(function_name, direction=direction, depth=depth, limit=limit)
