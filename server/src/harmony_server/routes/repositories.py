from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from harmony_agent.domain import (
    CreateSnapshotRequest,
    RegisterRepositoryRequest,
    RepositoryBranch,
    RepositoryRecord,
    RepositorySnapshot,
)
from harmony_agent.repositories import (
    RepositoryAlreadyExistsError,
    RepositoryGitError,
    RepositoryNotFoundError,
)

from ..dependencies import ApplicationContainer

router = APIRouter(prefix="/api/repositories", tags=["repositories"])


def container(request: Request) -> ApplicationContainer:
    return request.app.state.container


@router.get("", response_model=list[RepositoryRecord])
async def list_repositories(request: Request) -> list[RepositoryRecord]:
    return await container(request).repositories.list()


@router.post("", response_model=RepositoryRecord, status_code=status.HTTP_201_CREATED)
async def register_repository(
    payload: RegisterRepositoryRequest,
    request: Request,
) -> RepositoryRecord:
    try:
        return await container(request).repositories.register(payload)
    except RepositoryAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RepositoryGitError as exc:
        raise HTTPException(status_code=502, detail=f"仓库连接失败：{exc}") from exc


@router.get("/{repository_id}/branches", response_model=list[RepositoryBranch])
async def list_repository_branches(
    repository_id: str,
    request: Request,
    query: str = Query(default="", max_length=200),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[RepositoryBranch]:
    try:
        return await container(request).repositories.list_branches(
            repository_id,
            query=query,
            limit=limit,
        )
    except RepositoryNotFoundError as exc:
        raise HTTPException(status_code=404, detail="repository not found") from exc
    except RepositoryGitError as exc:
        raise HTTPException(status_code=502, detail=f"分支读取失败：{exc}") from exc


@router.post("/{repository_id}/snapshots", response_model=RepositorySnapshot)
async def create_repository_snapshot(
    repository_id: str,
    payload: CreateSnapshotRequest,
    request: Request,
) -> RepositorySnapshot:
    try:
        return await container(request).repositories.prepare_snapshot(
            repository_id,
            payload.branch,
        )
    except RepositoryNotFoundError as exc:
        raise HTTPException(status_code=404, detail="repository not found") from exc
    except RepositoryGitError as exc:
        raise HTTPException(status_code=422, detail=f"快照创建失败：{exc}") from exc
