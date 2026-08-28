from __future__ import annotations

from pathlib import Path

from harmony_repo_mcp import InspectionBoundaryError


def validate_workspace_path(path: str, allowed_roots: list[Path]) -> Path:
    try:
        workspace = Path(path).expanduser().resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise InspectionBoundaryError("workspace path does not exist") from exc
    if not workspace.is_dir():
        raise InspectionBoundaryError("workspace path must be a directory")
    for root in allowed_roots:
        resolved_root = root.expanduser().resolve()
        if workspace == resolved_root or resolved_root in workspace.parents:
            return workspace
    raise InspectionBoundaryError("workspace is outside HARMONY_AGENT_ALLOWED_ROOTS")
