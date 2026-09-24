"""Offline transport/contract regressions; opt-in live eval checks Skill-driven decisions."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastmcp import FastMCP
from pydantic_ai import ModelMessagesTypeAdapter, models
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from harmony_agent.agents import Completed, HarmonyChatAgent, ToolFinished
from harmony_agent.config import Settings
from harmony_agent.domain import Conversation
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    json.loads(line)
    for line in (Path(__file__).parent / "datasets/diagnosis_cases.jsonl").read_text().splitlines()
]


def registry() -> SkillRegistry:
    result = SkillRegistry(ROOT / "skills")
    result.load()
    return result


def settings(tmp_path, **kwargs) -> Settings:
    return Settings(
        _env_file=None,
        model_config_file=tmp_path / "model.json",
        knowledge_root=kwargs.pop("knowledge_root", ROOT / "knowledge"),
        knowledge_query_log="off",
        **kwargs,
    )


@pytest.mark.parametrize(
    "item", [c for c in CASES if c.get("scenario") == "tool_failure"], ids=lambda c: c["id"]
)
async def test_chat_recovers_from_tool_failures(item, tmp_path, monkeypatch) -> None:
    """Exercise the real chat agent, MCP, budget and evidence boundary with injected failures."""
    server = FastMCP("injected-failure")
    executed = []

    @server.tool
    def read_project_file(relative_path: str) -> dict:
        executed.append(relative_path)
        if relative_path != "present.ets":
            raise OSError("injected unreadable file")
        return {"path": relative_path, "content": "// no causal evidence"}

    monkeypatch.setattr("harmony_agent.toolsets.repository_mcp.create_mcp_server", lambda _: server)
    calls = iter(item["tool_calls"])
    budget_exhausted_seen = False

    async def respond(messages, info):
        nonlocal budget_exhausted_seen
        path = next(calls, None)
        if path:
            yield {
                0: DeltaToolCall(
                    name="read_project_file", json_args=json.dumps({"relative_path": path})
                )
            }
            return
        if item["failure_limit"] == len(item["expected_executed"]):
            assert not info.function_tools
            budget_exhausted_seen = True
        yield "多个源码证据无法读取，当前证据不足，请补充可访问的文件或日志。"

    agent = HarmonyChatAgent(
        registry(), ModelGateway(settings(tmp_path, tool_failure_limit=item["failure_limit"]))
    )
    agent.model_override = FunctionModel(stream_function=respond)
    conversation = Conversation(workspace_path=str(tmp_path))
    events = [event async for event in agent.stream_turn(conversation, item["description"])]

    assert isinstance(events[-1], Completed)
    assert "证据不足" in events[-1].text
    assert executed == item["expected_executed"]
    statuses = [event.event.status for event in events if isinstance(event, ToolFinished)]
    assert statuses == item["expected_tool_statuses"]
    if item["failure_limit"] == len(item["expected_executed"]):
        assert budget_exhausted_seen


def clarification_knowledge(tmp_path: Path, item: dict) -> Path:
    """Isolate transport evals from production content authoring and deleted mock entries."""
    root = tmp_path / "knowledge"
    (root / "symptoms").mkdir(parents=True)
    (root / "facts").mkdir()
    (root / "symptoms" / f"{item['knowledge_entry']}.md").write_text(
        f"---\nname: {item['knowledge_entry']}\nkind: symptom\n"
        f"symptom: {item['description']}\napplies_to: [harmony]\nauthority: auto\n"
        "updated_at: 2026-09-23\n---\n# 朗读无分数\n"
        "## 区分它们需要什么\n先区分新评测和我的作品回看 evaluationCheckView，再核实证据。\n",
        encoding="utf-8",
    )
    return root


@pytest.mark.parametrize(
    "item", [c for c in CASES if c.get("scenario") == "clarification"], ids=lambda c: c["id"]
)
async def test_clarification_tools_and_followup_history(item, tmp_path) -> None:
    """Script only the model: real Skill/knowledge tools and saved history must round-trip.

    This is not an assertion that an arbitrary provider will obey the Skill. See the live eval.
    """
    phase = 0

    async def scripted(messages, info):
        nonlocal phase
        phase += 1
        if phase == 1:
            yield {
                0: DeltaToolCall(
                    name="load_skill", json_args=json.dumps({"name": "locate-harmony-issue"})
                )
            }
        elif phase == 2:
            skill = messages[-1].parts[0].content
            assert "区分它们需要什么" in skill
            yield {
                0: DeltaToolCall(
                    name="lookup_issue",
                    json_args=json.dumps({"query": item["description"]}),
                )
            }
        elif phase == 3:
            body = json.dumps(messages[-1].parts[0].content, ensure_ascii=False)
            assert item["knowledge_entry"] in body
            assert "evaluationCheckView" in body
            assert "区分它们需要什么" in body
            yield item["question"]
        else:
            history = ModelMessagesTypeAdapter.dump_json(messages).decode()
            assert item["question"] in history
            assert item["answer"] in history
            assert "evaluationCheckView" in history
            yield item["followup"]

    agent = HarmonyChatAgent(
        registry(),
        ModelGateway(settings(tmp_path, knowledge_root=clarification_knowledge(tmp_path, item))),
    )
    agent.model_override = FunctionModel(stream_function=scripted)
    conversation = Conversation()
    first = [event async for event in agent.stream_turn(conversation, item["description"])]
    assert isinstance(first[-1], Completed)
    assert [event.event.tool for event in first if isinstance(event, ToolFinished)] == [
        "load_skill",
        "lookup_issue",
    ]
    conversation.messages_state = first[-1].messages_state
    second = [event async for event in agent.stream_turn(conversation, item["answer"])]
    assert isinstance(second[-1], Completed)
    assert item["narrowed_scope"] in second[-1].text
    assert not any(isinstance(event, ToolFinished) for event in second)


@pytest.mark.skipif(
    os.getenv("HARMONY_AGENT_LIVE_EVALS") != "1",
    reason="requires explicit live model eval configuration",
)
@pytest.mark.parametrize(
    "item", [c for c in CASES if c.get("scenario") == "clarification"], ids=lambda c: c["id"]
)
async def test_live_skill_clarifies_and_narrows(item, monkeypatch, tmp_path) -> None:
    """Run with HARMONY_AGENT_LIVE_EVALS=1 and configured model credentials (incurs usage)."""
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", True)
    gateway = ModelGateway(Settings(knowledge_root=clarification_knowledge(tmp_path, item)))
    agent = HarmonyChatAgent(registry(), gateway)
    conversation = Conversation()
    try:
        first = [event async for event in agent.stream_turn(conversation, item["description"])]
        assert isinstance(first[-1], Completed), first[-1]
        assert any(term in first[-1].text for term in item["question_terms"]), first[-1].text
        assert any(
            isinstance(event, ToolFinished) and event.event.tool == "lookup_issue"
            for event in first
        )
        conversation.messages_state = first[-1].messages_state
        second = [event async for event in agent.stream_turn(conversation, item["answer"])]
        assert isinstance(second[-1], Completed), second[-1]
        assert any(term in second[-1].text for term in item["scope_terms"])
    finally:
        await gateway.close()
