from pydantic_ai import Agent, models
from pydantic_ai.models.test import TestModel

from harmony_agent.domain import DiagnosisReport, Severity, Verdict


async def test_pydantic_ai_validates_structured_diagnosis_offline() -> None:
    models.ALLOW_MODEL_REQUESTS = False
    model = TestModel(
        custom_output_args={
            "verdict": Verdict.INSUFFICIENT_EVIDENCE,
            "severity": Severity.UNKNOWN,
            "summary": "证据不足",
            "issue_category": "待分类",
            "likely_location": None,
            "root_cause_candidates": [],
            "evidence": [],
            "ruled_out": [],
            "missing_information": ["错误日志"],
            "checks_performed": ["结构化输入"],
            "limitations": ["未执行运行态验证"],
            "confidence": 0.1,
        }
    )
    agent = Agent(model, output_type=DiagnosisReport, instructions="Diagnose only.")

    result = await agent.run("登录有问题")

    assert result.output.verdict == Verdict.INSUFFICIENT_EVIDENCE
    assert result.output.confidence == 0.1
