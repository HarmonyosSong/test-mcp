from __future__ import annotations

from harmony_agent.domain import (
    CaseStatus,
    CreateCaseRequest,
    DiagnosisCase,
    StageStatus,
)

from ..dependencies import ApplicationContainer
from .sources import resolve_source


async def create_case(
    payload: CreateCaseRequest,
    container: ApplicationContainer,
) -> DiagnosisCase:
    source = await resolve_source(
        repository_id=payload.repository_id,
        branch=payload.branch,
        workspace_path=payload.workspace_path,
        container=container,
    )
    case = DiagnosisCase.from_request(
        payload,
        source.workspace,
        repository_name=source.repository_name,
        resolved_commit=source.resolved_commit,
    )
    return await container.cases.save(case)


async def rerun_case(case: DiagnosisCase, container: ApplicationContainer) -> DiagnosisCase:
    case.report = None
    case.error = None
    case.tool_events = []
    case.status = CaseStatus.QUEUED
    for stage in case.stages:
        stage.status = StageStatus.PENDING
        stage.summary = ""
        stage.started_at = None
        stage.completed_at = None
    return await container.cases.save(case)


def export_case_markdown(case: DiagnosisCase) -> str:
    report = case.report
    lines = [f"# {case.title}", "", f"- 诊断编号: `{case.id}`", f"- 状态: `{case.status}`"]
    if case.repository_name:
        lines.extend(
            [
                f"- 仓库: `{case.repository_name}`",
                f"- 分支: `{case.requested_ref}`",
                f"- Commit: `{case.resolved_commit}`",
            ]
        )
    if not report:
        lines.extend(["", "诊断尚未生成。"])
        return "\n".join(lines)
    lines.extend(
        [
            f"- 诊断结论: `{report.verdict}`",
            f"- 置信度: {round(report.confidence * 100)}%",
            "",
            "## 结论",
            "",
            report.summary,
            "",
            "## 根因候选",
            "",
        ]
    )
    for candidate in report.root_cause_candidates:
        confidence = round(candidate.confidence * 100)
        lines.append(f"- **{candidate.title}** ({confidence}%): {candidate.explanation}")
    lines.extend(["", "## 证据", ""])
    for evidence in report.evidence:
        location = f" @ {evidence.location}" if evidence.location else ""
        lines.append(f"- `{evidence.id}` {evidence.source}{location}: {evidence.excerpt}")
    lines.extend(["", "## 信息缺口", ""])
    lines.extend(f"- {item}" for item in report.missing_information)
    lines.extend(["", "## 诊断边界", ""])
    lines.extend(f"- {item}" for item in report.limitations)
    return "\n".join(lines)
