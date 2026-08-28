from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from time import perf_counter
from uuid import uuid4

from ag_ui.core import EventType
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from harmony_agent.domain import (
    CaseStatus,
    CreateCaseRequest,
    DiagnosisCase,
    StageStatus,
)
from harmony_agent.repositories import RepositoryGitError, RepositoryNotFoundError
from harmony_repo_mcp import InspectionBoundaryError

from .dependencies import ApplicationContainer
from .services.cases import create_case
from .services.tasks import schedule_task
from .sse import sse_event as _sse

router = APIRouter(prefix="/api/agui", tags=["ag-ui"])


@router.post("/runs")
async def start_agui_run(
    payload: CreateCaseRequest,
    request: Request,
) -> StreamingResponse:
    container: ApplicationContainer = request.app.state.container
    try:
        case = await create_case(payload, container)
    except RepositoryNotFoundError as exc:
        raise HTTPException(status_code=404, detail="repository not found") from exc
    except (RepositoryGitError, InspectionBoundaryError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    run_id = f"run-{uuid4().hex[:12]}"
    schedule_task(request.app, container.workflow.run(case.id))
    return StreamingResponse(
        _stream_run(request, container, run_id, case),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _stream_run(
    request: Request,
    container: ApplicationContainer,
    run_id: str,
    initial_case: DiagnosisCase,
) -> AsyncIterator[str]:
    previous = initial_case.model_copy(deep=True)
    yield _sse(EventType.RUN_STARTED, run_id, case=initial_case)
    last_keepalive = perf_counter()
    while True:
        if await request.is_disconnected():
            return
        current = await container.cases.get(initial_case.id)
        for before, after in zip(previous.stages, current.stages, strict=True):
            if before.status == after.status:
                continue
            if after.status == StageStatus.RUNNING:
                yield _sse(
                    EventType.STEP_STARTED,
                    run_id,
                    case_id=current.id,
                    stage=after,
                )
            if after.status in {StageStatus.COMPLETED, StageStatus.FAILED}:
                if before.status == StageStatus.PENDING:
                    started_stage = after.model_copy(
                        update={"status": StageStatus.RUNNING, "completed_at": None}
                    )
                    yield _sse(
                        EventType.STEP_STARTED,
                        run_id,
                        case_id=current.id,
                        stage=started_stage,
                    )
                yield _sse(
                    EventType.STEP_FINISHED,
                    run_id,
                    case_id=current.id,
                    stage=after,
                )
        previous_tool_ids = {event.id for event in previous.tool_events}
        for tool_event in current.tool_events:
            if tool_event.id in previous_tool_ids:
                continue
            started_event = tool_event.model_copy(update={"status": "running"})
            yield _sse(
                EventType.TOOL_CALL_START,
                run_id,
                case_id=current.id,
                tool_event=started_event,
            )
            yield _sse(
                EventType.TOOL_CALL_END,
                run_id,
                case_id=current.id,
                tool_event=tool_event,
            )
        if current.model_dump_json() != previous.model_dump_json():
            yield _sse(EventType.STATE_SNAPSHOT, run_id, case=current)
        if current.status == CaseStatus.COMPLETED:
            yield _sse(EventType.RUN_FINISHED, run_id, case=current)
            return
        if current.status == CaseStatus.FAILED:
            yield _sse(
                EventType.RUN_ERROR,
                run_id,
                case_id=current.id,
                error=current.error or "diagnosis failed",
                case=current,
            )
            return
        previous = current.model_copy(deep=True)
        if perf_counter() - last_keepalive >= 10:
            yield ": keepalive\n\n"
            last_keepalive = perf_counter()
        await asyncio.sleep(0.12)
