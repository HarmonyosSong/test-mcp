from __future__ import annotations

import json
from pathlib import Path

import anyio
from fastapi.testclient import TestClient
from harmony_agent.config import Settings
from harmony_agent.domain import ChatMessage, ChatMessageStatus
from pydantic_ai import ModelMessagesTypeAdapter, models
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel

from harmony_server.main import create_app


def make_chat_client(tmp_path: Path) -> TestClient:
    project_root = Path(__file__).resolve().parents[2]
    settings = Settings(
        mode="demo",
        knowledge_query_log="off",
        model_config_file=tmp_path / "model-config.json",
        conversations_data_file=tmp_path / "conversations.json",
        repository_data_file=tmp_path / "repositories.json",
        git_mirror_dir=tmp_path / "mirrors",
        snapshot_dir=tmp_path / "snapshots",
        skills_dir=project_root / "skills",
        allowed_roots=[tmp_path],
    )
    return TestClient(create_app(settings))


def create_conversation(client: TestClient) -> dict:
    response = client.post("/api/conversations", json={"title": "排查会话"})
    assert response.status_code == 201
    return response.json()


def read_sse_events(response) -> list[dict]:
    events = []
    event_type = None
    for line in response.text.splitlines():
        if line.startswith("event: "):
            event_type = line.removeprefix("event: ").strip()
        elif line.startswith("data: ") and event_type:
            payload = json.loads(line.removeprefix("data: "))
            payload["_event"] = event_type
            events.append(payload)
            event_type = None
    return events


def test_conversation_crud(tmp_path: Path) -> None:
    with make_chat_client(tmp_path) as client:
        conversation = create_conversation(client)
        assert conversation["title"] == "排查会话"
        assert "messages_state" not in conversation

        listing = client.get("/api/conversations")
        assert listing.status_code == 200
        assert [item["id"] for item in listing.json()] == [conversation["id"]]
        assert listing.json()[0]["message_count"] == 0

        renamed = client.patch(f"/api/conversations/{conversation['id']}", json={"title": "改名了"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "改名了"

        detail = client.get(f"/api/conversations/{conversation['id']}")
        assert detail.status_code == 200

        deleted = client.delete(f"/api/conversations/{conversation['id']}")
        assert deleted.status_code == 204
        assert client.get(f"/api/conversations/{conversation['id']}").status_code == 404


def test_chat_message_requires_model(tmp_path: Path) -> None:
    with make_chat_client(tmp_path) as client:
        conversation = create_conversation(client)
        response = client.post(
            f"/api/conversations/{conversation['id']}/messages", json={"content": "你好"}
        )
        assert response.status_code == 409


def test_rejects_workspace_outside_allowed_roots(tmp_path: Path) -> None:
    with make_chat_client(tmp_path) as client:
        response = client.post(
            "/api/conversations",
            json={"title": "越界工作区", "workspace_path": str(tmp_path.parent)},
        )
        assert response.status_code == 422


def test_chat_message_streams_events(tmp_path: Path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    with make_chat_client(tmp_path) as client:
        client.app.state.container.chat_agent.model_override = TestModel(
            call_tools=[], custom_output_text="这是诊断回复"
        )
        # 不传标题，验证首轮消息自动生成标题
        created = client.post("/api/conversations", json={})
        assert created.status_code == 201
        conversation = created.json()
        with client.stream(
            "POST",
            f"/api/conversations/{conversation['id']}/messages",
            json={"content": "登录页点击没反应"},
        ) as response:
            assert response.status_code == 200
            response.read()
        events = read_sse_events(response)

    types = [event["_event"] for event in events]
    assert types[0] == "RUN_STARTED"
    assert "TEXT_MESSAGE_START" in types
    assert "TEXT_MESSAGE_CONTENT" in types
    assert types[-2] == "STATE_SNAPSHOT"
    assert types[-1] == "RUN_FINISHED"

    final = events[-1]["conversation"]
    assert "messages_state" not in final
    assert [message["role"] for message in final["messages"]] == ["user", "assistant"]
    assistant = final["messages"][-1]
    assert assistant["status"] == "completed"
    assert assistant["content"] == "这是诊断回复"
    # 首轮消息自动生成标题
    assert final["title"].startswith("登录页点击没反应")


def test_chat_tool_steps_visible_in_stream(tmp_path: Path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    calls = {"count": 0}

    async def scripted_stream(messages, info: AgentInfo):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {
                0: DeltaToolCall(name="load_skill", json_args='{"name": "locate-harmony-issue"}')
            }
        else:
            yield "已按技能指引分析"

    with make_chat_client(tmp_path) as client:
        client.app.state.container.chat_agent.model_override = FunctionModel(
            stream_function=scripted_stream
        )
        conversation = create_conversation(client)
        with client.stream(
            "POST",
            f"/api/conversations/{conversation['id']}/messages",
            json={"content": "帮我定位问题"},
        ) as response:
            response.read()
        events = read_sse_events(response)

    types = [event["_event"] for event in events]
    assert "TOOL_CALL_START" in types
    assert "TOOL_CALL_END" in types
    tool_end = next(event for event in events if event["_event"] == "TOOL_CALL_END")
    assert tool_end["tool_event"]["tool"] == "load_skill"
    assert tool_end["tool_event"]["status"] == "completed"
    assert tool_end["tool_event"]["duration_ms"] is not None

    final = events[-1]["conversation"]
    assistant = final["messages"][-1]
    assert [step["tool"] for step in assistant["steps"]] == ["load_skill"]


def test_chat_second_turn_appends_history(tmp_path: Path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    with make_chat_client(tmp_path) as client:
        client.app.state.container.chat_agent.model_override = TestModel(
            call_tools=[], custom_output_text="第二轮回复"
        )
        conversation = create_conversation(client)
        with client.stream(
            "POST",
            f"/api/conversations/{conversation['id']}/messages",
            json={"content": "第一轮"},
        ) as response:
            response.read()
        with client.stream(
            "POST",
            f"/api/conversations/{conversation['id']}/messages",
            json={"content": "第二轮"},
        ) as response:
            response.read()
        detail = client.get(f"/api/conversations/{conversation['id']}").json()

    assert [message["role"] for message in detail["messages"]] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert detail["messages"][-1]["content"] == "第二轮回复"


def test_chat_rejects_concurrent_turn(tmp_path: Path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    with make_chat_client(tmp_path) as client:
        client.app.state.container.chat_agent.model_override = TestModel(
            call_tools=[], custom_output_text="ok"
        )
        conversation = create_conversation(client)
        # 手动塞入一条 streaming 占位消息模拟进行中的轮次
        container = client.app.state.container

        async def corrupt():
            conv = await container.conversations.get(conversation["id"])
            conv.messages.append(ChatMessage(role="assistant", status=ChatMessageStatus.STREAMING))
            await container.conversations.save(conv)

        anyio.run(corrupt)
        response = client.post(
            f"/api/conversations/{conversation['id']}/messages", json={"content": "你好"}
        )
        assert response.status_code == 409


def test_failed_model_turn_preserves_user_input_for_followup(tmp_path: Path) -> None:
    calls = 0

    async def scripted(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(name="load_skill", json_args='{"name":"locate-harmony-issue"}')}
        elif calls == 2:
            raise RuntimeError("injected upstream failure after a tool call")
        else:
            # 按 part 检查(user_evidence 预览会在 instructions 状态块中引用用户原文,
            # 那不算输入重复):用户输入不重复,失败轮的孤儿工具对已被剥离。
            parsed = json.loads(ModelMessagesTypeAdapter.dump_json(messages))
            parts = [part for message in parsed for part in message["parts"]]
            user_prompts = [p["content"] for p in parts if p.get("part_kind") == "user-prompt"]
            assert sum("ORIGINAL_LOG" in content for content in user_prompts) == 1
            assert any("继续" in content for content in user_prompts)
            assert not any(p.get("part_kind") in {"tool-call", "tool-return"} for p in parts)
            yield "恢复成功"

    models.ALLOW_MODEL_REQUESTS = False
    with make_chat_client(tmp_path) as client:
        client.app.state.container.chat_agent.model_override = FunctionModel(
            stream_function=scripted
        )
        conversation = create_conversation(client)
        url = f"/api/conversations/{conversation['id']}/messages"
        first = client.post(url, json={"content": "Error ORIGINAL_LOG at Checkout.ets:88"})
        assert first.status_code == 200
        assert any(event["_event"] == "RUN_ERROR" for event in read_sse_events(first))
        second = client.post(url, json={"content": "继续排查刚才的问题"})
        assert second.status_code == 200
        saved = client.get(f"/api/conversations/{conversation['id']}").json()
        assert saved["messages"][-1]["status"] == "completed"
        assert saved["messages"][-1]["content"] == "恢复成功"


def test_chat_report_submission_persisted_on_message(tmp_path: Path) -> None:
    calls = 0

    async def scripted(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            # 引用式草稿:无证据引用的 insufficient_evidence 报告
            draft = {
                "verdict": "insufficient_evidence",
                "summary": "缺少现场日志，无法支撑候选",
                "issue_category": "unknown",
                "missing_information": ["需要完整 hilog 日志"],
                "confidence": 0.2,
            }
            yield {
                0: DeltaToolCall(
                    name="submit_diagnosis_report",
                    json_args=json.dumps({"draft": draft}),
                )
            }
        else:
            yield "已生成诊断报告：当前证据不足。"

    models.ALLOW_MODEL_REQUESTS = False
    with make_chat_client(tmp_path) as client:
        client.app.state.container.chat_agent.model_override = FunctionModel(
            stream_function=scripted
        )
        conversation = create_conversation(client)
        with client.stream(
            "POST",
            f"/api/conversations/{conversation['id']}/messages",
            json={"content": "登录页白屏"},
        ) as response:
            response.read()
        detail = client.get(f"/api/conversations/{conversation['id']}").json()

    assistant = detail["messages"][-1]
    assert assistant["status"] == "completed"
    assert assistant["report"]["verdict"] == "insufficient_evidence"
    assert assistant["report"]["missing_information"] == ["需要完整 hilog 日志"]
    assert [step["tool"] for step in assistant["steps"]] == ["submit_diagnosis_report"]
    assert "evidence_state" not in detail


def test_update_conversation_model_override(tmp_path: Path) -> None:
    with make_chat_client(tmp_path) as client:
        conversation = create_conversation(client)
        updated = client.patch(
            f"/api/conversations/{conversation['id']}",
            json={"model_override": "deepseek-reasoner"},
        )
        assert updated.status_code == 200
        assert updated.json()["model_override"] == "deepseek-reasoner"

        cleared = client.patch(
            f"/api/conversations/{conversation['id']}", json={"model_override": ""}
        )
        assert cleared.status_code == 200
        assert cleared.json()["model_override"] is None

        renamed = client.patch(f"/api/conversations/{conversation['id']}", json={"title": "新标题"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "新标题"


def test_available_models_requires_configured_model(tmp_path: Path) -> None:
    with make_chat_client(tmp_path) as client:
        response = client.get("/api/model/available-models")
        assert response.status_code == 409


def test_bind_request_reaches_tool_and_survives_restart(tmp_path: Path) -> None:
    from unittest.mock import AsyncMock

    from harmony_agent.domain import RepositoryRecord, RepositorySnapshot

    count = 0

    async def scripted(messages, info):
        nonlocal count
        count += 1
        if count == 1:
            assert "绑定 xesapp" in ModelMessagesTypeAdapter.dump_json(messages).decode()
            yield {0: DeltaToolCall(name="bind_repository", json_args='{"name_or_url":"xesapp"}')}
        else:
            yield "仓库快照已绑定。"

    with make_chat_client(tmp_path) as client:
        container = client.app.state.container
        container.chat_agent.model_override = FunctionModel(stream_function=scripted)
        container.repositories.list = AsyncMock(
            return_value=[
                RepositoryRecord(
                    id="repo-test",
                    name="xesapp",
                    url="https://example.com/repo.git",
                    default_branch="main",
                )
            ]
        )
        container.repositories.prepare_snapshot = AsyncMock(
            return_value=RepositorySnapshot(
                repository_id="repo-test",
                repository_name="xesapp",
                requested_ref="main",
                resolved_commit="abc123",
                workspace_path=str(tmp_path),
            )
        )
        conversation = create_conversation(client)
        response = client.post(
            f"/api/conversations/{conversation['id']}/messages", json={"content": "绑定 xesapp"}
        )
        assert response.status_code == 200
        container.repositories.prepare_snapshot.assert_awaited_once_with("repo-test", "main")
    with make_chat_client(tmp_path) as restarted:
        saved = restarted.get(f"/api/conversations/{conversation['id']}").json()
        assert saved["repository_id"] == "repo-test"
        assert saved["requested_ref"] == "main"
        assert saved["resolved_commit"] == "abc123"
        assert saved["messages"][0]["content"] == "绑定 xesapp"
        assert saved["messages"][1]["steps"][0]["tool"] == "bind_repository"
        assert len(list((tmp_path / "knowledge-cases").glob("*.json"))) == 1
