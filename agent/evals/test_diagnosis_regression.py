import json
from pathlib import Path

from harmony_agent.domain import CreateCaseRequest, DiagnosisCase
from harmony_agent.runtimes.demo import build_demo_report, collect_input_evidence


def test_deterministic_diagnosis_regression_dataset() -> None:
    dataset = Path(__file__).parent / "datasets" / "diagnosis_cases.jsonl"
    cases = [json.loads(line) for line in dataset.read_text(encoding="utf-8").splitlines()]

    for item in cases:
        case = DiagnosisCase.from_request(
            CreateCaseRequest(
                title=item["title"],
                description=item["description"],
                evidence=item["evidence"],
            ),
            workspace=None,
        )
        report = build_demo_report(case, collect_input_evidence(case))
        assert report.verdict.value == item["expected_verdict"], item["title"]
