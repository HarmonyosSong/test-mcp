from __future__ import annotations

from fastmcp import FastMCP

from ..inspector import ProjectInspector
from ..schemas import FileContent


def register_file_reader_tools(server: FastMCP, inspector: ProjectInspector) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def read_project_file(
        relative_path: str,
        start_line: int = 1,
        end_line: int = 200,
    ) -> FileContent:
        """Read a bounded line range from one allowed snapshot text file."""
        return inspector.read_project_file(relative_path, start_line, end_line)
