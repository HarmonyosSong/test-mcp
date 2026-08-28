from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import PlainTextResponse
from harmony_agent.domain import CreateCaseRequest, DiagnosisCase
from harmony_agent.repositories import (
    CaseNotFoundError,
    RepositoryGitError,
    RepositoryNotFoundError,
)
from harmony_repo_mcp import InspectionBoundaryError

from ..dependencies import ApplicationContainer
from ..services.cases import create_case, export_case_markdown, rerun_case
from ..services.tasks import schedule_task

router = APIRouter(prefix="/api/cases", tags=["cases"])


def container(request: Request) -> ApplicationContainer:
    return request.app.state.container


@router.get("", response_model=list[DiagnosisCase])
async def list_cases(request: Request) -> list[DiagnosisCase]:
    return await container(request).cases.list()


@router.post("", response_model=DiagnosisCase, status_code=status.HTTP_202_ACCEPTED)
async def create_diagnosis_case(
    payload: CreateCaseRequest,
    request: Request,
) -> DiagnosisCase:
    try:
        case = await create_case(payload, container(request))
    except RepositoryNotFoundError as exc:
        raise HTTPException(status_code=404, detail="repository not found") from exc
    except (RepositoryGitError, InspectionBoundaryError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    schedule_task(request.app, container(request).workflow.run(case.id))
    return case


@router.get("/{case_id}", response_model=DiagnosisCase)
async def get_case(case_id: str, request: Request) -> DiagnosisCase:
    try:
        return await container(request).cases.get(case_id)
    except CaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail="diagnosis case not found") from exc


@router.post("/{case_id}/run", response_model=DiagnosisCase, status_code=202)
async def run_case_again(case_id: str, request: Request) -> DiagnosisCase:
    try:
        case = await container(request).cases.get(case_id)
    except CaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail="diagnosis case not found") from exc
    case = await rerun_case(case, container(request))
    schedule_task(request.app, container(request).workflow.run(case.id))
    return case


@router.get("/{case_id}/export")
async def export_case(
    case_id: str,
    request: Request,
    format: str = Query(default="markdown", pattern="^(markdown|json)$"),
) -> Response:
    try:
        case = await container(request).cases.get(case_id)
    except CaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail="diagnosis case not found") from exc
    if format == "json":
        return Response(
            content=case.model_dump_json(indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{case.id}.json"'},
        )
    return PlainTextResponse(
        export_case_markdown(case),
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{case.id}.md"'},
    )
