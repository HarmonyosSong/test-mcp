"""长期 API Token：ctl 颁发、Bearer 校验、吊销与过期。"""

from __future__ import annotations

import time

import pytest
from starlette.testclient import TestClient

from log_mcp.config import Settings
from log_mcp.server import create_app
from log_mcp.token_store import DEFAULT_TOKEN_TTL_DAYS, TokenStore
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
    tc = TestClient(app, base_url="http://127.0.0.1:8766")
    tc.__enter__()
    return tc


def test_issue_returns_token_once_and_list_hides_plaintext(store: TokenStore) -> None:
    token, expires_in = store.issue_token(
        client_id="odyssey",
        description="runtime",
        scopes="logs:read",
    )
    assert isinstance(token, str) and len(token) > 20
    assert expires_in == DEFAULT_TOKEN_TTL_DAYS * 86_400
    clients = store.list_clients()
    assert len(clients) == 1
    assert clients[0]["client_id"] == "odyssey"
    assert "token" not in clients[0]
    assert "secret" not in clients[0]
    assert clients[0]["revoked"] is False
    assert clients[0]["expires_at"]


def test_verify_bearer_token(store: TokenStore) -> None:
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    assert store.verify_access_token(f"Bearer {token}") == ("odyssey", "logs:read")


def test_verify_wrong_token(store: TokenStore) -> None:
    store.issue_token(client_id="odyssey", scopes="logs:read")
    assert store.verify_access_token("Bearer wrong-token") is None


def test_verify_revoked(store: TokenStore) -> None:
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    assert store.revoke_client("odyssey") is True
    assert store.verify_access_token(f"Bearer {token}") is None


def test_verify_expired(store: TokenStore) -> None:
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read", ttl_seconds=0)
    time.sleep(0.01)
    assert store.verify_access_token(f"Bearer {token}") is None


def test_reissue_replaces_old_token(store: TokenStore) -> None:
    old, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    new, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    assert old != new
    assert store.verify_access_token(f"Bearer {old}") is None
    assert store.verify_access_token(f"Bearer {new}") == ("odyssey", "logs:read")


def test_verify_no_header(store: TokenStore) -> None:
    assert store.verify_access_token(None) is None


def test_verify_bad_scheme(store: TokenStore) -> None:
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
    assert store.verify_access_token(f"Basic {token}") is None


def test_oauth_endpoints_removed(client: TestClient) -> None:
    assert client.post("/oauth/token", data={"grant_type": "client_credentials"}).status_code == 404
    assert client.post("/oauth/revoke", data={"token": "x"}).status_code == 404


def test_mcp_rejects_no_token(client: TestClient) -> None:
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


def test_mcp_accepts_issued_token(client: TestClient, store: TokenStore) -> None:
    token, _ = store.issue_token(client_id="odyssey", scopes="logs:read")
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
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code != 401


def test_health_no_auth(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_cleanup_expired(store: TokenStore) -> None:
    store.issue_token(client_id="odyssey", scopes="logs:read", ttl_seconds=0)
    time.sleep(0.01)
    assert store.cleanup_expired() == 1
    assert store.list_clients() == []
