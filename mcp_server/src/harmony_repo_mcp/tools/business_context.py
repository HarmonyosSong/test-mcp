from __future__ import annotations

from fastmcp import FastMCP

from ..inspector import ProjectInspector
from ..schemas import BusinessContextDocument


def register_business_context_tools(server: FastMCP, inspector: ProjectInspector) -> None:
    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def load_business_context(query: str, limit: int = 8) -> list[BusinessContextDocument]:
        """Load repository-local skills, contracts, and module references relevant to an issue."""
        return inspector.load_business_context(query, limit)
