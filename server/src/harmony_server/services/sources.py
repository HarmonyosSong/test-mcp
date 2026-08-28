from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from harmony_agent.workspace import validate_workspace_path

if TYPE_CHECKING:
    from ..dependencies import ApplicationContainer


@dataclass(frozen=True)
class ResolvedSource:
    workspace: Path | None
    repository_name: str | None
    resolved_commit: str | None


async def resolve_source(
    *,
    repository_id: str | None,
    branch: str | None,
    workspace_path: str | None,
    container: ApplicationContainer,
) -> ResolvedSource:
    """解析案例/会话共用的代码来源：仓库快照优先，其次本地工作区。"""
    if repository_id and branch:
        snapshot = await container.repositories.prepare_snapshot(repository_id, branch)
        return ResolvedSource(
            workspace=Path(snapshot.workspace_path),
            repository_name=snapshot.repository_name,
            resolved_commit=snapshot.resolved_commit,
        )
    if workspace_path:
        return ResolvedSource(
            workspace=validate_workspace_path(workspace_path, container.settings.allowed_roots),
            repository_name=None,
            resolved_commit=None,
        )
    return ResolvedSource(workspace=None, repository_name=None, resolved_commit=None)
