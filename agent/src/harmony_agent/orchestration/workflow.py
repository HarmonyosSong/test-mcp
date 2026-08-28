from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from ..agents import HarmonyDiagnosisAgent
from ..config import Settings
from ..domain import (
    CaseStatus,
    DiagnosisCase,
    DiagnosisReport,
    Severity,
    StageKey,
    StageStatus,
    Verdict,
    utc_now,
)
from ..repositories import CaseRepository
from ..runtimes.demo import build_demo_report, collect_input_evidence, inspect_workspace
from ..runtimes.model_gateway import ModelGateway
from .stages import diagnosis_summary, intake_summary, investigation_summary, location_summary


class DiagnosisWorkflow:
    def __init__(
        self,
        repository: CaseRepository,
        settings: Settings,
        diagnosis_agent: HarmonyDiagnosisAgent,
        model_gateway: ModelGateway,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.diagnosis_agent = diagnosis_agent
        self.model_gateway = model_gateway

    async def run(self, case_id: str) -> None:
        case = await self.repository.get(case_id)
        case.status = CaseStatus.RUNNING
        case.error = None
        await self.repository.save(case)
        try:
            await self._stage(case, StageKey.INTAKE, lambda current: _done(intake_summary(current)))
            evidence = collect_input_evidence(case)
            await self._stage(
                case,
                StageKey.LOCATE,
                lambda _current: _done(location_summary(len(evidence))),
            )
            evidence, workspace_checks, tool_events = await inspect_workspace(case, evidence)
            case.tool_events.extend(tool_events)
            await self._stage(
                case,
                StageKey.INVESTIGATE,
                lambda _current: _done(investigation_summary(len(evidence), workspace_checks)),
            )
            await self._start_stage(case, StageKey.DIAGNOSE)
            if self.model_gateway.enabled:
                report = await self.diagnosis_agent.run(case, evidence, workspace_checks)
            else:
                report = build_demo_report(case, evidence)
                report.checks_performed.extend(workspace_checks)
            case.report = report
            self._complete_stage(case, StageKey.DIAGNOSE, diagnosis_summary(report))
            case.status = CaseStatus.COMPLETED
            await self.repository.save(case)
        except Exception as exc:
            self._fail_running_stage(case, str(exc))
            case.report = self._partial_failure_report(exc)
            case.status = CaseStatus.FAILED
            case.error = str(exc)
            await self.repository.save(case)

    async def _stage(
        self,
        case: DiagnosisCase,
        key: StageKey,
        operation: Callable[[DiagnosisCase], Awaitable[str]],
    ) -> None:
        await self._start_stage(case, key)
        summary = await operation(case)
        self._complete_stage(case, key, summary)
        await self.repository.save(case)

    async def _start_stage(self, case: DiagnosisCase, key: StageKey) -> None:
        stage = self._get_stage(case, key)
        stage.status = StageStatus.RUNNING
        stage.started_at = utc_now()
        await self.repository.save(case)
        if self.settings.stage_delay_ms:
            await asyncio.sleep(self.settings.stage_delay_ms / 1_000)

    @staticmethod
    def _complete_stage(case: DiagnosisCase, key: StageKey, summary: str) -> None:
        stage = DiagnosisWorkflow._get_stage(case, key)
        stage.status = StageStatus.COMPLETED
        stage.summary = summary
        stage.completed_at = utc_now()

    @staticmethod
    def _fail_running_stage(case: DiagnosisCase, error: str) -> None:
        for stage in case.stages:
            if stage.status == StageStatus.RUNNING:
                stage.status = StageStatus.FAILED
                stage.summary = f"阶段失败：{error}"
                stage.completed_at = utc_now()

    @staticmethod
    def _get_stage(case: DiagnosisCase, key: StageKey):
        return next(stage for stage in case.stages if stage.key == key)

    @staticmethod
    def _partial_failure_report(exc: Exception) -> DiagnosisReport:
        return DiagnosisReport(
            verdict=Verdict.TOOL_ERROR,
            severity=Severity.UNKNOWN,
            summary="诊断流程未完整完成，当前不能形成可靠根因结论。",
            issue_category="未完成",
            missing_information=["修复模型或只读工具连接后重新执行诊断"],
            checks_performed=[],
            limitations=[
                f"诊断流程错误：{type(exc).__name__}: {exc}",
                "未调用 DevEco CLI，也未修改任何项目文件",
            ],
            confidence=0,
        )


async def _done(value: str) -> str:
    return value
