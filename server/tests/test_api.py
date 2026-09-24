from pathlib import Path

from fastapi.testclient import TestClient
from harmony_agent.config import Settings
from harmony_agent.domain import ModelConnectionResult

from harmony_server.main import create_app


def make_client(tmp_path: Path) -> TestClient:
    project_root = Path(__file__).resolve().parents[2]
    settings = Settings(
        mode="demo",
        model_config_file=tmp_path / "model-config.json",
        conversations_data_file=tmp_path / "conversations.json",
        repository_data_file=tmp_path / "repositories.json",
        git_mirror_dir=tmp_path / "mirrors",
        snapshot_dir=tmp_path / "snapshots",
        skills_dir=project_root / "skills",
        allowed_roots=[tmp_path],
    )
    return TestClient(create_app(settings))


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
