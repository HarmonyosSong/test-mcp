from __future__ import annotations

from fastmcp import FastMCP

from ..inspector import ProjectInspector
from ..schemas import HilogSummary


def register_log_parser_tools(server: FastMCP, inspector: ProjectInspector) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def parse_hilog(log_text: str, limit: int = 50) -> HilogSummary:
        """Extract error lines and referenced source files from pasted hilog text."""
        return inspector.parse_hilog(log_text, limit)
