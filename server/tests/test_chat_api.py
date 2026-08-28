from __future__ import annotations

import json
from pathlib import Path

import anyio
from fastapi.testclient import TestClient
from harmony_agent.config import Settings
from harmony_agent.domain import ChatMessage, ChatMessageStatus
from pydantic_ai import models
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel

from harmony_server.main import create_app


def make_chat_client(tmp_path: Path) -> TestClient:
    project_root = Path(__file__).resolve().parents[2]
    settings = Settings(
        mode="demo",
        data_file=tmp_path / "cases.json",
        model_config_file=tmp_path / "model-config.json",
        conversations_data_file=tmp_path / "conversations.json",
        repository_data_file=tmp_path / "repositories.json",
        git_mirror_dir=tmp_path / "mirrors",
        snapshot_dir=tmp_path / "snapshots",
        skills_dir=project_root / "skills",
        allowed_roots=[tmp_path],
        stage_delay_ms=0,
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

        promote = client.post(f"/api/conversations/{conversation['id']}/promote-draft")
        assert promote.status_code == 409


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


def test_promote_draft_and_link_case(tmp_path: Path) -> None:
    models.ALLOW_MODEL_REQUESTS = False
    with make_chat_client(tmp_path) as client:
        container = client.app.state.container
        container.chat_agent.model_override = TestModel(
            call_tools=[], custom_output_text="分析完毕"
        )
        container.promote_agent.model_override = TestModel(
            call_tools=[],
            custom_output_text=json.dumps(
                {
                    "title": "登录页按钮无反应",
                    "description": "点击登录按钮没有响应",
                    "evidence": "hilog 报错片段",
                }
            ),
        )
        conversation = create_conversation(client)
        with client.stream(
            "POST",
            f"/api/conversations/{conversation['id']}/messages",
            json={"content": "登录页有问题"},
        ) as response:
            response.read()

        draft_response = client.post(f"/api/conversations/{conversation['id']}/promote-draft")
        assert draft_response.status_code == 200
        draft = draft_response.json()
        assert draft["title"] == "登录页按钮无反应"

        # 用草稿创建案例并回写会话
        created = client.post("/api/cases", json=draft)
        assert created.status_code == 202
        case_id = created.json()["id"]
        linked = client.post(
            f"/api/conversations/{conversation['id']}/cases", json={"case_id": case_id}
        )
        assert linked.status_code == 200
        body = linked.json()
        assert body["case_ids"] == [case_id]
        assert body["messages"][-1]["case_id"] == case_id

        missing = client.post(
            f"/api/conversations/{conversation['id']}/cases",
            json={"case_id": "case-missing"},
        )
        assert missing.status_code == 404


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
