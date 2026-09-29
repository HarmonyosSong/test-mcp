from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from pydantic_ai import ModelMessagesTypeAdapter, models
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel

from harmony_agent.agents import (
    Completed,
    Failed,
    HarmonyChatAgent,
    ModelNotConfiguredError,
    TextDelta,
    ToolFinished,
    ToolStarted,
)
from harmony_agent.config import Settings
from harmony_agent.domain import Conversation, trim_messages_state
from harmony_agent.repositories import ConversationRepository
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime.registry import SkillRegistry

SKILL_BODY = "# Demo Skill\n\n按步骤定位问题。"


def _registry(tmp_path: Path) -> SkillRegistry:
    skill_dir = tmp_path / "skills" / "demo-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: demo-skill\n"
        "description: 演示技能\n"
        "metadata:\n"
        '  version: "0.1.0"\n'
        "  stage: general\n"
        "---\n\n"
        f"{SKILL_BODY}\n",
        encoding="utf-8",
    )
    registry = SkillRegistry(tmp_path / "skills")
    registry.load()
    return registry


def _chat_agent(tmp_path: Path, model) -> HarmonyChatAgent:
    agent = HarmonyChatAgent(
        _registry(tmp_path),
        ModelGateway(Settings(model_config_file=tmp_path / "model-config.json")),
    )
    agent.model_override = model
    return agent


async def _collect(agent: HarmonyChatAgent, conversation: Conversation, content: str):
    return [event async for event in agent.stream_turn(conversation, content)]


async def test_stream_turn_requires_configured_model(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    agent = HarmonyChatAgent(
        _registry(tmp_path),
        ModelGateway(Settings(model_config_file=tmp_path / "model-config.json")),
    )
    with pytest.raises(ModelNotConfiguredError):
        await _collect(agent, Conversation(), "你好")


async def test_stream_turn_streams_text_and_persists_history(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    agent = _chat_agent(tmp_path, TestModel(call_tools=[], custom_output_text="这是回复正文"))

    events = await _collect(agent, Conversation(), "登录页点不动")

    completed = [event for event in events if isinstance(event, Completed)]
    assert len(completed) == 1
    assert completed[0].text == "这是回复正文"
    assert completed[0].tool_usage["model_requests"] == 1
    assert completed[0].tool_usage["elapsed_ms"] >= 0
    # messages_state 必须能被 PydanticAI 回读，作为下一轮 message_history
    restored = ModelMessagesTypeAdapter.validate_python(completed[0].messages_state)
    assert len(restored) >= 2  # 本轮的 request + response


async def test_stream_turn_load_skill_visible_as_tool_step(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    calls = {"count": 0}

    async def scripted_stream(messages, info: AgentInfo):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {0: DeltaToolCall(name="load_skill", json_args='{"name": "demo-skill"}')}
        else:
            yield "已按技能指引分析完毕"

    agent = _chat_agent(tmp_path, FunctionModel(stream_function=scripted_stream))
    events = await _collect(agent, Conversation(), "帮我定位问题")

    started = [event for event in events if isinstance(event, ToolStarted)]
    finished = [event for event in events if isinstance(event, ToolFinished)]
    assert [event.event.tool for event in started] == ["load_skill"]
    assert [event.event.tool for event in finished] == ["load_skill"]
    assert started[0].event.id == finished[0].event.id
    assert finished[0].event.status == "completed"
    assert SKILL_BODY in (finished[0].event.result_summary or "")
    assert "demo-skill" in (finished[0].event.arguments_summary or "")
    assert isinstance(events[-1], Completed)


async def test_stream_turn_unknown_skill_retries_then_answers(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    calls = {"count": 0}

    async def scripted_stream(messages, info: AgentInfo):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {0: DeltaToolCall(name="load_skill", json_args='{"name": "no-such-skill"}')}
        else:
            # load_skill 抛出 ModelRetry 后，模型应收到重试提示并改为直接回答
            yield "技能不存在，改为直接回答"

    agent = _chat_agent(tmp_path, FunctionModel(stream_function=scripted_stream))
    events = await _collect(agent, Conversation(), "排查一下")

    finished = [event for event in events if isinstance(event, ToolFinished)]
    assert finished and finished[0].event.status == "failed"
    assert isinstance(events[-1], Completed)


async def test_stream_turn_model_error_becomes_failed_event(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False

    async def broken_stream(messages, info: AgentInfo):
        raise RuntimeError("upstream exploded")
        yield  # pragma: no cover —— 仅用于声明为异步生成器

    agent = _chat_agent(tmp_path, FunctionModel(stream_function=broken_stream))
    events = await _collect(agent, Conversation(), "你好")

    assert isinstance(events[-1], Failed)
    assert "upstream exploded" in events[-1].error
    assert events[-1].tool_usage["model_requests"] == 1
    assert events[-1].tool_usage["elapsed_ms"] >= 0
    assert not any(isinstance(event, TextDelta) for event in events)


def _fake_state(pairs: int, body: str = "x" * 100) -> list[dict]:
    state: list[dict] = []
    for index in range(pairs):
        state.append(
            {"kind": "request", "parts": [{"part_kind": "user-prompt", "content": f"q{index}"}]}
        )
        state.append(
            {
                "kind": "response",
                "parts": [{"part_kind": "text", "content": body * (index + 1)}],
            }
        )
    return state


def test_trim_messages_state_drops_oldest_pairs() -> None:
    state = _fake_state(30)
    trimmed = trim_messages_state(state, max_messages=10, max_chars=1_000_000)
    assert len(trimmed) <= 10
    assert trimmed[0]["kind"] == "request"
    # 剩余的请求/响应必须成对（response 数量与 request 数量一致）
    kinds = [message["kind"] for message in trimmed]
    assert kinds.count("request") == kinds.count("response")


def test_trim_messages_state_truncates_tool_returns() -> None:
    state = [
        {"kind": "request", "parts": [{"part_kind": "user-prompt", "content": "q"}]},
        {
            "kind": "response",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "read_project_file",
                    "content": "y" * 20_000,
                }
            ],
        },
    ]
    trimmed = trim_messages_state(state, max_messages=40, max_chars=5_000)
    content = trimmed[1]["parts"][0]["content"]
    assert len(content) < 5_000
    assert content.endswith("...(已截断,原文共 20000 字符,仅存前 4000)")


class StubRepositoryManager:
    """模拟已登记仓库与快照，不触碰 git。"""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace

    async def list(self):
        from harmony_agent.domain import RepositoryRecord

        return [
            RepositoryRecord(
                id="repo-xesapp",
                name="xesapp",
                url="https://git.100tal.com/peiyou_xueersi_harmony/xesapp.git",
                default_branch="master",
            )
        ]

    async def prepare_snapshot(self, repository_id: str, branch: str):
        from harmony_agent.domain import RepositorySnapshot

        return RepositorySnapshot(
            repository_id=repository_id,
            repository_name="xesapp",
            requested_ref=branch,
            resolved_commit="abc123def456",
            workspace_path=str(self.workspace),
        )


def _deps_agent(tmp_path: Path, model) -> tuple[HarmonyChatAgent, ConversationRepository]:

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "order.ets").write_text("// 组合加购订单入口\nfunction addToCart() {}\n")
    conversations = ConversationRepository(tmp_path / "conversations.json")
    agent = HarmonyChatAgent(
        _registry(tmp_path),
        ModelGateway(Settings(model_config_file=tmp_path / "model-config.json")),
        StubRepositoryManager(workspace),
        conversations,
    )
    agent.model_override = model
    return agent, conversations


async def test_bind_repository_then_search_in_same_turn(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    agent, conversations = _deps_agent(tmp_path, None)
    conversation = Conversation(title="组合加购")
    await conversations.initialize()
    await conversations.save(conversation)

    calls = {"count": 0}

    async def scripted_stream(messages, info: AgentInfo):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {
                0: DeltaToolCall(
                    name="bind_repository",
                    json_args='{"name_or_url": "xesapp", "branch": "releaseV/20260825"}',
                )
            }
        elif calls["count"] == 2:
            yield {0: DeltaToolCall(name="search_project_text", json_args='{"query": "组合加购"}')}
        else:
            yield "组合加购入口在 order.ets 的 addToCart"

    agent.model_override = FunctionModel(stream_function=scripted_stream)
    events = await _collect(agent, conversation, "帮我看组合加购订单逻辑")

    finished = [event.event for event in events if isinstance(event, ToolFinished)]
    assert [event.tool for event in finished] == ["bind_repository", "search_project_text"]
    assert all(event.status == "completed" for event in finished)
    assert "releaseV/20260825" in (finished[0].result_summary or "")
    assert "order.ets" in (finished[1].result_summary or "")

    # 绑定已写入会话并持久化
    persisted = await conversations.get(conversation.id)
    assert persisted.repository_name == "xesapp"
    assert persisted.requested_ref == "releaseV/20260825"
    assert persisted.workspace_path is not None
    assert persisted.resolved_commit == "abc123def456"


@pytest.mark.parametrize("branch", [None, "releaseV/existing", "releaseV/new"])
async def test_binding_preserves_existing_snapshot_unless_branch_changes(tmp_path, branch) -> None:
    agent, conversations = _deps_agent(tmp_path, None)
    conversation = Conversation(
        workspace_path=str(agent.repositories.workspace),
        repository_id="repo-xesapp",
        repository_name="xesapp",
        requested_ref="releaseV/existing",
        resolved_commit="original-commit",
    )
    await conversations.initialize()
    await conversations.save(conversation)
    prepare = AsyncMock(wraps=agent.repositories.prepare_snapshot)
    agent.repositories.prepare_snapshot = prepare
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            assert "releaseV/existing" in info.instructions
            assert "original-commit" in info.instructions
            args = {"name_or_url": "xesapp"}
            if branch:
                args["branch"] = branch
            yield {0: DeltaToolCall(name="bind_repository", json_args=json.dumps(args))}
        else:
            yield "继续调查"

    agent.model_override = FunctionModel(stream_function=respond)
    events = await _collect(
        agent, conversation, "确认现有绑定" if branch != "releaseV/new" else "切换到 releaseV/new"
    )
    assert isinstance(events[-1], Completed)
    persisted = await conversations.get(conversation.id)
    if branch == "releaseV/new":
        prepare.assert_awaited_once_with("repo-xesapp", branch)
        assert persisted.requested_ref == branch
    else:
        prepare.assert_not_awaited()
        assert persisted.requested_ref == "releaseV/existing"
        assert persisted.resolved_commit == "original-commit"


@pytest.mark.parametrize("can_bind", [False, True])
async def test_chat_catalog_and_loader_enforce_tool_requirements(tmp_path, can_bind) -> None:
    agent = _deps_agent(tmp_path, None)[0] if can_bind else _chat_agent(tmp_path, None)
    registry = SkillRegistry(Path(__file__).resolve().parents[2] / "skills")
    registry.load()
    agent.registry = registry
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            # 报告 Skill 在统一聊天路径下始终可用（submit 工具始终挂载）；
            # 绑定 Skill 仅在有仓储依赖时出现。
            assert "report-harmony-diagnosis" in info.instructions
            assert ("bind-harmony-workspace" in info.instructions) is can_bind
            yield {
                0: DeltaToolCall(name="load_skill", json_args='{"name":"report-harmony-diagnosis"}')
            }
        else:
            yield "已加载报告技能，继续排查。"

    agent.model_override = FunctionModel(stream_function=respond)
    events = await _collect(agent, Conversation(), "排查问题")
    finished = [event.event for event in events if isinstance(event, ToolFinished)]
    assert finished[0].status == "completed"
    assert "submit_diagnosis_report" in (finished[0].result_summary or "")
    assert isinstance(events[-1], Completed)


async def test_bind_repository_rejects_unregistered_repo(tmp_path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    agent, conversations = _deps_agent(tmp_path, None)
    conversation = Conversation(title="乱绑仓库")
    await conversations.initialize()
    await conversations.save(conversation)

    calls = {"count": 0}

    async def scripted_stream(messages, info: AgentInfo):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {
                0: DeltaToolCall(
                    name="bind_repository", json_args='{"name_or_url": "unknown-repo"}'
                )
            }
        else:
            yield "该仓库未登记，请先登记"

    agent.model_override = FunctionModel(stream_function=scripted_stream)
    events = await _collect(agent, conversation, "帮我看 unknown-repo 的代码")

    finished = [event.event for event in events if isinstance(event, ToolFinished)]
    assert finished[0].tool == "bind_repository"
    assert finished[0].status == "failed"
    assert "未找到登记的仓库" in (finished[0].result_summary or "")

    persisted = await conversations.get(conversation.id)
    assert persisted.workspace_path is None


@pytest.mark.parametrize("lazy_workspace", [False, True])
async def test_failed_call_is_blocked_and_budget_resets_next_turn(
    tmp_path, monkeypatch, lazy_workspace
) -> None:
    from harmony_repo_mcp.inspector import ProjectInspector

    attempts = []

    def broken_read(self, relative_path, start_line=1, end_line=200):
        attempts.append(relative_path)
        raise OSError("injected failure")

    monkeypatch.setattr(ProjectInspector, "read_project_file", broken_read)
    requests = 0

    async def scripted(messages, info):
        nonlocal requests
        requests += 1
        if requests in (1, 2, 4):
            yield {
                0: DeltaToolCall(name="read_project_file", json_args='{"relative_path":"a.ets"}')
            }
        else:
            yield "读取失败，当前证据不足。"

    model = FunctionModel(stream_function=scripted)
    if lazy_workspace:
        agent, _ = _deps_agent(tmp_path, model)
        workspace = tmp_path / "workspace"
    else:
        agent = _chat_agent(tmp_path, model)
        workspace = tmp_path
    conversation = Conversation(workspace_path=str(workspace))
    first = await _collect(agent, conversation, "查 a.ets")
    assert isinstance(first[-1], Completed)
    assert attempts == ["a.ets"]
    finished = [event.event for event in first if isinstance(event, ToolFinished)]
    assert [event.status for event in finished] == ["failed", "failed"]
    assert "禁止原样重试" in finished[-1].result_summary
    conversation.messages_state = first[-1].messages_state
    second = await _collect(agent, conversation, "下一轮再检查")
    assert isinstance(second[-1], Completed)
    assert attempts == ["a.ets", "a.ets"]


async def test_unexecuted_model_tool_markup_is_a_failed_turn(tmp_path):
    model = TestModel(
        call_tools=[], custom_output_text='<｜｜DSML｜｜ invoke name="bind_repository">'
    )
    agent = _chat_agent(tmp_path, model)
    events = await _collect(agent, Conversation(), "绑定仓库")
    assert isinstance(events[-1], Failed)
    assert "未执行" in events[-1].error
    assert not any(isinstance(event, Completed) for event in events)
