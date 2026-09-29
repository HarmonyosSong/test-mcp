from __future__ import annotations

from fastmcp import FastMCP

from ..inspector import ProjectInspector
from ..schemas import DEFAULT_SEARCH_LIMIT, SearchPage


def register_code_search_tools(server: FastMCP, inspector: ProjectInspector) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def list_project_files(pattern: str = "**/*", limit: int = 100) -> list[str]:
        """List allowed text files inside the authorized repository snapshot."""
        return inspector.list_project_files(pattern, limit)

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def search_project_text(
        query: str,
        file_glob: str = "**/*",
        limit: int = DEFAULT_SEARCH_LIMIT,
        cursor: str | None = None,
    ) -> SearchPage:
        """Search snapshot text files for a literal, case-insensitive string.

        Returns a bounded page. When truncated is true, pass next_cursor back with the
        same query/file_glob to continue; scan_limit_reached means the scan did not
        cover every file, so narrow file_glob instead of claiming no repository hit.
        """
        return inspector.search_project_text(query, file_glob, limit, cursor=cursor)
