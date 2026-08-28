from types import SimpleNamespace

import pytest
from pydantic import RootModel, ValidationError

from harmony_agent.domain import (
    CreateCaseRequest,
    DiagnosisCase,
    DiagnosisReport,
    RootCauseCandidate,
    Verdict,
)
from harmony_agent.runtimes.demo import (
    _tool_items,
    build_demo_report,
    category_for,
    collect_input_evidence,
)


def test_vague_issue_returns_insufficient_evidence() -> None:
    case = DiagnosisCase.from_request(
        CreateCaseRequest(title="登录有问题", description="登录功能现在有问题"),
        workspace=None,
    )

    report = build_demo_report(case, collect_input_evidence(case))

    assert report.verdict == Verdict.INSUFFICIENT_EVIDENCE
    assert report.root_cause_candidates == []
    assert report.missing_information


def test_positive_verdict_requires_linked_evidence() -> None:
    with pytest.raises(ValidationError, match="linked to evidence"):
        DiagnosisReport(
            verdict=Verdict.PROBABLE,
            summary="A probable cause",
            issue_category="runtime",
            root_cause_candidates=[
                RootCauseCandidate(
                    title="Candidate",
                    explanation="Explanation",
                    confidence=0.8,
                    evidence_ids=["missing"],
                )
            ],
            confidence=0.8,
        )


def test_runtime_error_takes_priority_over_page_symptom() -> None:
    assert category_for("登录页面白屏 TypeError: value is undefined") == "ArkTS 运行时异常"


def test_fastmcp_root_models_are_normalized_to_mappings() -> None:
    wrapped = RootModel[dict[str, object]]({"path": "XesOrder/Order.ets", "line": 42})
    fastmcp_root = SimpleNamespace(path="XesOrder/Pay.ets", line=7)

    assert _tool_items([wrapped, fastmcp_root]) == [
        {"path": "XesOrder/Order.ets", "line": 42},
        {"path": "XesOrder/Pay.ets", "line": 7},
    ]
