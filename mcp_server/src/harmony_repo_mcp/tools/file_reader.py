from __future__ import annotations

from fastmcp import FastMCP

from ..inspector import ProjectInspector
from ..schemas import DEFAULT_READ_CHARS, FileContent


def register_file_reader_tools(server: FastMCP, inspector: ProjectInspector) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def read_project_file(
        relative_path: str,
        start_line: int = 1,
        end_line: int = 200,
        max_chars: int = DEFAULT_READ_CHARS,
    ) -> FileContent:
        """Read a bounded line range from one allowed snapshot text file.

        Delivers whole lines within the character budget (line numbers count towards
        it). When truncated is true, continue from next_line instead of re-reading
        from the top; has_more_in_file only means the file continues past end_line.
        """
        return (
            inspector.read_project_file(relative_path, start_line, end_line, max_chars)
            if max_chars != DEFAULT_READ_CHARS
            # 默认预算走旧三参形式:保持与既有签名消费者(含测试替身)兼容
            else inspector.read_project_file(relative_path, start_line, end_line)
        )
