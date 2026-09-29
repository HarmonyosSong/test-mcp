from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai.exceptions import ModelRetry, ToolFailed
from pydantic_ai.toolsets import FunctionToolset

from ..domain import DiagnosisReport, DiagnosisReportDraft
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
    def submit_diagnosis_report(draft: DiagnosisReportDraft) -> dict:
        """提交本次排查的结构化诊断报告（收尾动作，不是继续调查的手段）。

        仅当证据足够支撑结论，或用户明确要求输出报告时调用。证据是**引用式**的：
        evidence 数组每条只需三个字段——id（evidence_refs 返回的观测 ID，或
        instructions 里 user_evidence 给出的 ev-user-* 引用）、excerpt（该条观测
        原文/用户原话的逐字子串）、supports（这条引用支撑什么结论）。kind、source、
        location 由系统从观测账本组装，不要自己填。正向根因候选的 evidence_ids 至少
        挂一条源码或日志观测，用户引用只能支撑现象存在。知识命中只能作为线索，
        不能作为证据。校验失败会返回错误码与原因，修正后可再次提交。
        """
        try:
            resolved = ledger.resolve_draft(draft)
        except ModelRetry as exc:
            raise ToolFailed(f"报告校验未通过：{exc}") from None
        holder.report = resolved
        return {
            "status": "submitted",
            "verdict": str(resolved.verdict),
            "evidence_count": len(resolved.evidence),
            "message": "诊断报告已提交并通过证据校验；可向用户总结结论、证据和缺口。",
        }

    return toolset
