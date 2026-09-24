from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai.exceptions import ModelRetry, ToolFailed
from pydantic_ai.toolsets import FunctionToolset

from ..domain import DiagnosisReport
from ..runtimes.evidence import EvidenceLedger

SUBMIT_REPORT_TOOL = "submit_diagnosis_report"


@dataclass
class ReportHolder:
    """本轮已提交并通过校验的报告；每轮至多保留最新一份。"""

    report: DiagnosisReport | None = None


def build_report_submission_toolset(
    ledger: EvidenceLedger, holder: ReportHolder
) -> FunctionToolset[None]:
    """把结构化诊断报告暴露为收尾工具：提交即校验，校验不过返回错误让模型修正。"""

    toolset: FunctionToolset[None] = FunctionToolset()

    @toolset.tool_plain
    def submit_diagnosis_report(report: DiagnosisReport) -> dict:
        """提交本次排查的结构化诊断报告（收尾动作，不是继续调查的手段）。

        仅当证据足够支撑结论，或用户明确要求输出报告时调用。报告中的每条证据
        必须来自本轮或此前轮次的真实工具观测（evidence_refs）或用户提供的材料，
        逐条保留来源与原文摘录；知识命中只能作为线索，不能作为证据。
        校验失败会返回具体原因，修正后可再次提交。
        """
        try:
            validated = ledger.validate(report)
        except ModelRetry as exc:
            raise ToolFailed(f"报告校验未通过：{exc}") from None
        holder.report = validated
        return {
            "status": "submitted",
            "verdict": str(validated.verdict),
            "evidence_count": len(validated.evidence),
            "message": "诊断报告已提交并通过证据校验；可向用户总结结论、证据和缺口。",
        }

    return toolset
