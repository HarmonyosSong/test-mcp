"""OAuth client_credentials + token 存储测试。"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from log_mcp.config import Settings
from log_mcp.server import create_app
from log_mcp.token_store import TokenStore
from tests.conftest import make_settings


@pytest.fixture
def settings(tmp_path) -> Settings:
    return make_settings(tmp_path, auth_disabled=False)


@pytest.fixture
def store(settings: Settings) -> TokenStore:
    return TokenStore(settings.data_root_path / "auth.db")


@pytest.fixture
def app(settings: Settings, store: TokenStore):
    return create_app(settings, token_store=store)


@pytest.fixture
def client(app) -> TestClient:
    # 用 with 触发 lifespan，启动 MCP session_manager
    # base_url 让 Host 落入 MCP SDK 的 allowed_hosts
    tc = TestClient(app, base_url="http://127.0.0.1:8766")
    tc.__enter__()
    return tc


def _register(store: TokenStore, client_id: str = "odyssey", scopes: str = "logs:read") -> str:
    return store.register_client(client_id=client_id, description="test", scopes=scopes)


def test_register_returns_secret_once(store: TokenStore) -> None:
    secret = _register(store)
    assert isinstance(secret, str) and len(secret) > 20
    # list 不显示 secret
    clients = store.list_clients()
    assert len(clients) == 1
    assert "secret" not in clients[0]
    assert clients[0]["client_id"] == "odyssey"


def test_verify_client_correct(store: TokenStore) -> None:
    secret = _register(store)
    assert store.verify_client("odyssey", secret) == "logs:read"


def test_verify_client_wrong_secret(store: TokenStore) -> None:
    _register(store)
    assert store.verify_client("odyssey", "wrong") is None


def test_verify_client_revoked(store: TokenStore) -> None:
    secret = _register(store)
    assert store.revoke_client("odyssey") is True
    assert store.verify_client("odyssey", secret) is None


def test_issue_and_verify_token(store: TokenStore) -> None:
    _register(store)
    token, expires_in = store.issue_token(client_id="odyssey", scopes="logs:read")
    assert expires_in == 3600
    assert store.verify_access_token(f"Bearer {token}") == ("odyssey", "logs:read")


def test_verify_token_expired(store: TokenStore) -> None:
    _register(store)
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read", ttl_seconds=0)
    # ttl=0 立即过期
    import time

    time.sleep(0.01)
    assert store.verify_access_token(f"Bearer {token}") is None


def test_verify_token_no_header(store: TokenStore) -> None:
    assert store.verify_access_token(None) is None


def test_verify_token_bad_scheme(store: TokenStore) -> None:
    _register(store)
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    assert store.verify_access_token(f"Basic {token}") is None


def test_oauth_token_endpoint(client: TestClient, store: TokenStore) -> None:
    secret = _register(store)
    resp = client.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": "odyssey",
            "client_secret": secret,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "Bearer"
    assert body["expires_in"] == 3600
    assert body["scope"] == "logs:read"
    assert isinstance(body["access_token"], str)


def test_oauth_token_wrong_secret_returns_401(client: TestClient, store: TokenStore) -> None:
    _register(store)
    resp = client.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": "odyssey",
            "client_secret": "wrong",
        },
    )
    assert resp.status_code == 401
    assert resp.json()["error"] == "invalid_client"


def test_oauth_token_unsupported_grant(client: TestClient) -> None:
    resp = client.post("/oauth/token", data={"grant_type": "password"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "unsupported_grant_type"


def test_oauth_revoke_returns_204(client: TestClient, store: TokenStore) -> None:
    secret = _register(store)
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    resp = client.post(
        "/oauth/revoke",
        data={
            "token": token,
            "client_id": "odyssey",
            "client_secret": secret,
        },
    )
    assert resp.status_code == 204
    # 吊销后令牌失效
    assert store.verify_access_token(f"Bearer {token}") is None


def test_oauth_revoke_unknown_token_still_204(client: TestClient, store: TokenStore) -> None:
    secret = _register(store)
    resp = client.post(
        "/oauth/revoke",
        data={
            "token": "nonexistent",
            "client_id": "odyssey",
            "client_secret": secret,
        },
    )
    assert resp.status_code == 204


def test_mcp_rejects_no_token(client: TestClient) -> None:
    # 直接 POST /mcp 应被 BearerAuthDispatcher 拦下
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "t", "version": "1"},
            },
        },
    )
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate", "").startswith("Bearer")


def test_health_no_auth(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_cleanup_expired(store: TokenStore) -> None:
    _register(store)
    store.issue_token(client_id="odyssey", scopes="logs:read", ttl_seconds=0)
    import time

    time.sleep(0.01)
    assert store.cleanup_expired() == 1
