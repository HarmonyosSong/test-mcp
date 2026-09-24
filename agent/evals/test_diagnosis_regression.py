"""确定性回归：合并后的对话诊断路径，端到端验证「观测 -> 证据 -> 校验报告」。

脚本只替代模型决策；知识库、仓库工具、证据账本与报告校验均为真实实现。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from harmony_agent.agents import Completed, HarmonyChatAgent
from harmony_agent.config import Settings
from harmony_agent.domain import Conversation, DiagnosisReport, Evidence, RootCauseCandidate
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    json.loads(line)
    for line in (Path(__file__).parent / "datasets/diagnosis_cases.jsonl").read_text().splitlines()
    if "scenario" not in json.loads(line)
]


async def run_case(item: dict, tmp_path: Path) -> Completed:
    registry = SkillRegistry(ROOT / "skills")
    registry.load()
    gateway = ModelGateway(
        Settings(
            _env_file=None,
            knowledge_root=ROOT / "knowledge",
            knowledge_query_log="off",
            model_config_file=tmp_path / f"model-{len(list(tmp_path.glob('model*.json')))}.json",
        )
    )
    workspace = tmp_path / f"workspace-{abs(hash(item['title'])) % 100000}"
    workspace.mkdir(exist_ok=True)
    content = item["description"] + ("\n" + item["evidence"] if item["evidence"] else "")
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if item["evidence"] and calls == 1:
            (workspace / "LoginPage.ets").write_text(f"// page\n{item['evidence']}\n")
            yield {
                0: DeltaToolCall(
                    name="read_project_file",
                    json_args=json.dumps({"relative_path": "LoginPage.ets"}),
                )
            }
            return
        if (item["evidence"] and calls == 2) or (not item["evidence"] and calls == 1):
            if item["evidence"]:
                payload = messages[-1].parts[0].content
                reference = payload["evidence_refs"][0]
                report = DiagnosisReport(
                    verdict="probable",
                    summary="LoginPage.ets 抛出 TypeError",
                    issue_category="runtime",
                    confidence=0.6,
                    evidence=[
                        Evidence(
                            **reference,
                            excerpt=payload["result"]["content"],
                            supports="TypeError",
                        )
                    ],
                    root_cause_candidates=[
                        RootCauseCandidate(
                            title="TypeError",
                            explanation="页面抛出未捕获异常",
                            confidence=0.6,
                            evidence_ids=[reference["id"]],
                        )
                    ],
                )
            else:
                report = DiagnosisReport(
                    verdict="insufficient_evidence",
                    summary="描述模糊，缺少可观测证据",
                    issue_category="unknown",
                    missing_information=["需要复现步骤与 hilog 日志"],
                    confidence=0.2,
                )
            yield {
                0: DeltaToolCall(
                    name="submit_diagnosis_report",
                    json_args=json.dumps({"report": report.model_dump(mode="json")}),
                )
            }
            return
        yield "已向用户总结结论与缺口。"

    agent = HarmonyChatAgent(registry, gateway)
    agent.model_override = FunctionModel(stream_function=respond)
    conversation = Conversation(workspace_path=str(workspace))
    events = [event async for event in agent.stream_turn(conversation, content)]
    return next(event for event in events if isinstance(event, Completed))


def test_merged_diagnosis_path_end_to_end(tmp_path) -> None:
    async def run() -> None:
        for item in CASES:
            completed = await run_case(item, tmp_path)
            assert completed.report is not None, item["title"]
            assert completed.report.verdict.value == item["expected_verdict"], item["title"]
            if item["expected_verdict"] == "probable":
                assert completed.evidence_state["entries"], item["title"]
                assert completed.report.evidence[0].kind == "source"
            else:
                assert not completed.evidence_state["entries"], item["title"]

    asyncio.run(run())
