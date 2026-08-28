import json
import time
from pathlib import Path

from fastapi.testclient import TestClient
from harmony_agent.config import Settings
from harmony_agent.domain import ModelConnectionResult

from harmony_server.main import create_app


def make_client(tmp_path: Path) -> TestClient:
    project_root = Path(__file__).resolve().parents[2]
    settings = Settings(
        mode="demo",
        data_file=tmp_path / "cases.json",
        model_config_file=tmp_path / "model-config.json",
        repository_data_file=tmp_path / "repositories.json",
        git_mirror_dir=tmp_path / "mirrors",
        snapshot_dir=tmp_path / "snapshots",
        skills_dir=project_root / "skills",
        allowed_roots=[tmp_path],
        stage_delay_ms=0,
    )
    return TestClient(create_app(settings))


def wait_for_terminal_case(client: TestClient, case_id: str) -> dict:
    for _ in range(100):
        response = client.get(f"/api/cases/{case_id}")
        case = response.json()
        if case["status"] in {"completed", "failed"}:
            return case
        time.sleep(0.01)
    raise AssertionError("diagnosis did not finish")


def test_demo_diagnosis_end_to_end_and_export(tmp_path: Path) -> None:
    evidence = "TypeError: Cannot read property 'name' of undefined at LoginPage.ets:42"
    with make_client(tmp_path) as client:
        response = client.post(
            "/api/cases",
            json={
                "title": "登录页启动白屏",
                "description": "启动后白屏并抛出 TypeError",
                "evidence": evidence,
            },
        )
        assert response.status_code == 202

        case = wait_for_terminal_case(client, response.json()["id"])
        markdown = client.get(f"/api/cases/{case['id']}/export?format=markdown")

    assert case["status"] == "completed"
    assert case["report"]["verdict"] == "probable"
    assert case["report"]["root_cause_candidates"][0]["evidence_ids"]
    assert [stage["status"] for stage in case["stages"]] == ["completed"] * 4
    assert "未调用 DevEco CLI" in markdown.text


def test_rejects_workspace_outside_allowed_roots(tmp_path: Path) -> None:
    outside = tmp_path.parent
    with make_client(tmp_path) as client:
        response = client.post(
            "/api/cases",
            json={
                "title": "构建失败",
                "description": "构建日志报错",
                "workspace_path": str(outside),
            },
        )

    assert response.status_code == 422
    assert "outside" in response.json()["detail"]


def test_configures_and_disables_runtime_model_without_leaking_key(tmp_path: Path) -> None:
    secret = "sk-runtime-secret"
    with make_client(tmp_path) as client:
        providers = client.get("/api/model/providers")
        configured = client.put(
            "/api/model/config",
            json={
                "provider": "deepseek",
                "model_name": "deepseek-chat",
                "api_key": secret,
            },
        )
        health = client.get("/api/health")
        meta = client.get("/api/meta")
        disabled = client.delete("/api/model/config")

    assert providers.status_code == 200
    assert "custom" in {item["id"] for item in providers.json()}
    assert configured.status_code == 200
    assert configured.json()["api_key_configured"] is True
    assert secret not in configured.text
    assert health.json()["mode"] == "model"
    assert health.json()["provider"] == "DeepSeek"
    assert meta.json()["model"] == "deepseek-chat"
    assert disabled.json()["mode"] == "demo"


def test_model_connection_endpoint_uses_gateway_result(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    gateway = client.app.state.container.model_gateway

    async def fake_test_connection(_payload):
        return ModelConnectionResult(
            ok=True,
            provider="custom",
            model_name="local-model",
            latency_ms=12,
            response_preview="OK",
        )

    gateway.test_connection = fake_test_connection
    with client:
        response = client.post(
            "/api/model/test",
            json={
                "provider": "custom",
                "model_name": "local-model",
                "base_url": "http://127.0.0.1:11434/v1",
                "no_api_key": True,
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "provider": "custom",
        "model_name": "local-model",
        "latency_ms": 12,
        "response_preview": "OK",
    }


def test_validation_errors_redact_model_api_key(tmp_path: Path) -> None:
    secret = "super-secret-do-not-leak"
    with make_client(tmp_path) as client:
        response = client.post(
            "/api/model/test",
            json={
                "provider": "custom",
                "model_name": "local-model",
                "base_url": "http://127.0.0.1:11434/v1",
                "api_key": secret,
                "no_api_key": True,
            },
        )

    assert response.status_code == 422
    assert secret not in response.text
    assert "**********" in response.text


def test_agui_stream_emits_run_stage_snapshot_and_finish_events(tmp_path: Path) -> None:
    with (
        make_client(tmp_path) as client,
        client.stream(
            "POST",
            "/api/agui/runs",
            json={
                "title": "登录页启动白屏",
                "description": "启动后白屏并抛出 TypeError",
                "evidence": "TypeError at LoginPage.ets:42",
            },
        ) as response,
    ):
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = [
            json.loads(line.removeprefix("data: "))
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]

    event_types = [event["type"] for event in events]
    assert event_types[0] == "RUN_STARTED"
    assert "STEP_STARTED" in event_types
    assert "STATE_SNAPSHOT" in event_types
    assert event_types[-1] == "RUN_FINISHED"
    assert events[-1]["case"]["report"]["verdict"] == "probable"
