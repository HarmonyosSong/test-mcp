import pytest
from pydantic import ValidationError

from harmony_agent.domain import (
    DiagnosisReport,
    Evidence,
    EvidenceKind,
    RootCauseCandidate,
    Verdict,
)


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


def test_positive_verdict_requires_every_candidate_linked() -> None:
    observed = Evidence(
        kind=EvidenceKind.SOURCE,
        source="mcp:read_project_file",
        location="A.ets:1",
        excerpt="observed",
        supports="observation",
    )
    with pytest.raises(ValidationError, match="require every candidate linked"):
        DiagnosisReport(
            verdict=Verdict.LOCATED,
            summary="Located",
            issue_category="runtime",
            evidence=[observed],
            root_cause_candidates=[
                RootCauseCandidate(
                    title="Linked",
                    explanation="has evidence",
                    confidence=0.9,
                    evidence_ids=[observed.id],
                ),
                RootCauseCandidate(
                    title="Unlinked",
                    explanation="no evidence",
                    confidence=0.5,
                    evidence_ids=[],
                ),
            ],
            confidence=0.9,
        )


def test_insufficient_evidence_allows_empty_candidates() -> None:
    report = DiagnosisReport(
        verdict=Verdict.INSUFFICIENT_EVIDENCE,
        summary="Not enough material",
        issue_category="unknown",
        missing_information=["需要完整 hilog"],
        confidence=0.2,
    )
    assert report.root_cause_candidates == []
