"""鉴权与 scope 强制测试。"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from log_mcp.config import Settings
from log_mcp.server import create_app
from log_mcp.token_store import TokenStore
from tests.conftest import make_settings


def _settings(tmp_path, *, auth_disabled: bool = False, host: str = "127.0.0.1") -> Settings:
    return make_settings(tmp_path, auth_disabled=auth_disabled, host=host)


def _up(body: dict[str, Any]) -> bytes:
    return json.dumps({"code": 0, "msg": "ok", **body}).encode()


def _handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        content=_up(
            {
                "data": {
                    "list": [{"id": 1, "name": "n"}],
                    "total": 1,
                    "total_page": 1,
                    "page": 1,
                    "size": 20,
                },
            }
        ),
    )


def _make_app(settings: Settings, store: TokenStore, transport=None):
    return create_app(
        settings, token_store=store, transport=transport or httpx.MockTransport(_handler)
    )


def _make_client(settings: Settings, store: TokenStore | None = None, transport=None) -> TestClient:
    """构造 TestClient 并进入 lifespan（启动 MCP session_manager）。

    用 127.0.0.1:8766 作为 base_url，让 Host 头落入 MCP SDK 的 allowed_hosts
    （"127.0.0.1:*"），避免 DNS rebinding 保护拦截 testserver。
    """
    store = store or TokenStore(settings.data_root_path / "auth.db")
    app = _make_app(settings, store, transport=transport)
    tc = TestClient(app, base_url="http://127.0.0.1:8766")
    tc.__enter__()
    return tc


def _parse_sse(resp) -> dict[str, Any]:
    """从 MCP streamable HTTP 的 SSE 响应里抽 data: JSON。"""
    text = resp.text
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            return json.loads(line[len("data:") :].strip())
    # 非流式响应直接 JSON
    return resp.json()


def _init_session(
    client: TestClient, token: str | None = None
) -> tuple[dict[str, Any], str | None]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
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
        headers=headers,
    )
    return _parse_sse(resp), resp.headers.get("Mcp-Session-Id")


def _list_tools(client: TestClient, token: str | None, session_id: str | None = None) -> Any:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        },
        headers=headers,
    )
    return resp.json()


def test_auth_disabled_only_loopback(tmp_path) -> None:
    """LOG_MCP_AUTH_DISABLED=true 且绑定 0.0.0.0 → 开关失效并报错。"""
    settings = _settings(tmp_path, auth_disabled=True, host="0.0.0.0")  # noqa: S104
    store = TokenStore(settings.data_root_path / "auth.db")
    with pytest.raises(RuntimeError, match="回环地址"):
        create_app(settings, token_store=store)


def test_auth_disabled_loopback_ok(tmp_path) -> None:
    """LOG_MCP_AUTH_DISABLED=true 且绑定 127.0.0.1 → 放行 + /health 返回 auth:disabled。"""
    settings = _settings(tmp_path, auth_disabled=True, host="127.0.0.1")
    store = TokenStore(settings.data_root_path / "auth.db")
    client = _make_client(settings, store)
    resp = client.get("/health")
    assert resp.json()["auth"] == "disabled"


def test_scope_logs_probe_only_can_call_probe_tools(tmp_path) -> None:
    """logs:probe scope 仅可调 cloud_probe / list_services / get_fields。"""
    settings = _settings(tmp_path)
    store = TokenStore(settings.data_root_path / "auth.db")
    store.register_client(
        client_id="probe-only",
        description="t",
        scopes="logs:probe",
    )
    # 换 token
    token, _ = store.issue_token(client_id="probe-only", scopes="logs:probe")
    client = _make_client(settings, store)

    init, session_id = _init_session(client, token)
    # list_services 应允许
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "list_services", "arguments": {}},
        },
        headers={"Authorization": f"Bearer {token}", "Mcp-Session-Id": session_id}
        if session_id
        else {"Authorization": f"Bearer {token}"},
    )
    body = _parse_sse(resp)
    # 工具调用结果在 result.result.content[0].text
    text = body["result"]["content"][0]["text"]
    payload = json.loads(text)
    assert payload.get("source") == "logcenter"  # 成功


def test_scope_logs_probe_cannot_call_query(tmp_path) -> None:
    """logs:probe scope 调 query → permission 错误。"""
    settings = _settings(tmp_path)
    store = TokenStore(settings.data_root_path / "auth.db")
    store.register_client(client_id="probe-only", description="t", scopes="logs:probe")
    token, _ = store.issue_token(client_id="probe-only", scopes="logs:probe")
    client = _make_client(settings, store)

    init, session_id = _init_session(client, token)
    headers = {"Authorization": f"Bearer {token}"}
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "query", "arguments": {"serviceId": 1, "time": "15m"}},
        },
        headers=headers,
    )
    body = _parse_sse(resp)
    text = body["result"]["content"][0]["text"]
    payload = json.loads(text)
    assert payload["error"]["code"] == "permission"


def test_scope_logs_read_can_call_all(tmp_path) -> None:
    """logs:read scope 可调全部工具。"""
    settings = _settings(tmp_path)
    store = TokenStore(settings.data_root_path / "auth.db")
    store.register_client(client_id="reader", description="t", scopes="logs:read")
    token, _ = store.issue_token(client_id="reader", scopes="logs:read")
    client = _make_client(settings, store)

    init, session_id = _init_session(client, token)
    headers = {"Authorization": f"Bearer {token}"}
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "query", "arguments": {"serviceId": 1, "time": "15m"}},
        },
        headers=headers,
    )
    body = _parse_sse(resp)
    text = body["result"]["content"][0]["text"]
    payload = json.loads(text)
    assert payload.get("source") == "logcenter"


def test_debug_paths_return_subset(tmp_path) -> None:
    """/mcp/logcenter 只返回 7 个工具；/mcp/cloud 只返回 6 个。"""
    settings = _settings(tmp_path, auth_disabled=True)
    store = TokenStore(settings.data_root_path / "auth.db")
    client = _make_client(settings, store)

    for path, expected_count in [("/mcp/logcenter", 7), ("/mcp/cloud", 6)]:
        # 初始化 session
        init = client.post(
            path,
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
        session_id = init.headers.get("Mcp-Session-Id")
        headers = {}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        resp = client.post(
            path,
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {},
            },
            headers=headers,
        )
        tools = _parse_sse(resp)["result"]["tools"]
        assert len(tools) == expected_count, (
            f"{path} 应有 {expected_count} 个工具，实际 {len(tools)}"
        )


def test_all_path_returns_14_tools(tmp_path) -> None:
    """/mcp 返回全部 14 个工具。"""
    settings = _settings(tmp_path, auth_disabled=True)
    store = TokenStore(settings.data_root_path / "auth.db")
    client = _make_client(settings, store)

    init = client.post(
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
    session_id = init.headers.get("Mcp-Session-Id")
    headers = {}
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        },
        headers=headers,
    )
    tools = _parse_sse(resp)["result"]["tools"]
    assert len(tools) == 14
    names = {t["name"] for t in tools}
    from log_mcp.server import ALL_TOOL_NAMES

    assert ALL_TOOL_NAMES.issubset(names)
