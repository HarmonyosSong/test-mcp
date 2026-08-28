from __future__ import annotations

from fastmcp import FastMCP

from ..inspector import ProjectInspector
from ..schemas import SearchMatch


def register_code_search_tools(server: FastMCP, inspector: ProjectInspector) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def list_project_files(pattern: str = "**/*", limit: int = 100) -> list[str]:
        """List allowed text files inside the authorized repository snapshot."""
        return inspector.list_project_files(pattern, limit)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def search_project_text(
        query: str,
        file_glob: str = "**/*",
        limit: int = 50,
    ) -> list[SearchMatch]:
        """Search snapshot text files for a literal, case-insensitive string."""
        return inspector.search_project_text(query, file_glob, limit)
