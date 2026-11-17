"""云日志 6 个工具测试。"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from log_mcp.config import Settings
from log_mcp.server import LogMcpServer, _build_factories
from log_mcp.tools.cloudlog import register_cloudlog_tools
from tests.conftest import make_settings


def _settings(tmp_path) -> Settings:
    return make_settings(tmp_path)


def _cl_body(body: dict[str, Any]) -> bytes:
    return json.dumps({"code": 0, "msg": "ok", **body}).encode()


def _make_server(settings: Settings, handler) -> LogMcpServer:
    transport = httpx.MockTransport(handler)
    _, cloudlog_factory = _build_factories(settings, transport=transport)
    server = LogMcpServer(name="test-cl")
    register_cloudlog_tools(
        server,
        client_factory=cloudlog_factory,
        defaults=settings.cloudlog.defaults,
    )
    return server


async def _call(server: LogMcpServer, name: str, args: dict[str, Any]):
    return await server.call_tool(name, args)


def test_cloud_accounts(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_cl_body(
                {
                    "data": {"accounts": [{"account": "a1", "vendor": "aliyun"}], "total": 1},
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "cloud_accounts", {}))
    payload = json.loads(result.content[0].text)
    assert payload["source"] == "cloud"
    assert payload["accounts"][0]["account"] == "a1"


def test_cloud_topics(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_cl_body(
                {
                    "data": {
                        "topics": [
                            {
                                "topic_id": "t1",
                                "collection_id": "c1",
                                "region": "cn-beijing",
                                "vendor": "aliyun",
                            },
                        ],
                        "total": 1,
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "cloud_topics", {"account": "a1"}))
    payload = json.loads(result.content[0].text)
    assert payload["topics"][0]["topic_id"] == "t1"


def test_cloud_count_no_query_param(tmp_path) -> None:
    """cloud_count 不支持 query 过滤（方案 3.4 ②）。"""

    def handler(request: httpx.Request) -> httpx.Response:
        # 验证请求里没有 query 参数
        assert "query" not in request.url.params
        return httpx.Response(200, content=_cl_body({"data": {"total": 100}}))

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "cloud_count", {"topic": "t1", "time": "15m"}))
    payload = json.loads(result.content[0].text)
    assert payload["total"] == 100
    assert "logs" not in payload


def test_cloud_search_uses_defaults(tmp_path) -> None:
    """不传 account/collection/region 时用配置默认。"""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["account"] = request.url.params.get("account_ak_id")
        captured["collection"] = request.url.params.get("collection_id")
        captured["region"] = request.url.params.get("region")
        return httpx.Response(
            200,
            content=_cl_body(
                {
                    "data": {
                        "logs": [{"__time__": 1, "message": "m", "password": "p"}],
                        "total": 1,
                        "progress": "Complete",
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "cloud_search", {"topic": "t1", "time": "15m", "full": True}))
    payload = json.loads(result.content[0].text)
    # 默认坐标来自配置
    assert captured["account"] == "1743276692096170"
    assert captured["collection"] == "pysy-front-log"
    assert captured["region"] == "cn-beijing"
    # full 模式保留字段并脱敏
    assert payload["logs"][0]["password"] == "<redacted>"


def test_cloud_search_compact_keeps_troubleshoot_fields(tmp_path) -> None:
    """云日志精简白名单：保留排障字段，丢弃冗余噪声。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_cl_body(
                {
                    "data": {
                        "logs": [
                            {
                                "__time__": "1",
                                "__source__": "HarmonyOS",
                                "__topic__": "HarmonyOS",
                                "uid": "24966209",
                                "eventid": "network_apm",
                                "eventname": "network_apm",
                                "status": "fail",
                                "desc": "network_apm",
                                "requestUrl": "https://api.example/x",
                                "httpCode": "404",
                                "traceId": "t1",
                                "version": "7.106.1",
                                "rsd": "huge-ua-dup",
                                "noise_field": "drop-me",
                                "__tag__:__pack_id__": "drop-me",
                                "__tag__:__client_ip__": "1.2.3.4",
                            }
                        ],
                        "total": 1,
                        "progress": "Complete",
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "cloud_search", {"topic": "t1", "time": "15m", "full": False}))
    payload = json.loads(result.content[0].text)
    log = payload["logs"][0]
    assert log["uid"] == "24966209"
    assert log["eventid"] == "network_apm"
    assert log["requestUrl"] == "https://api.example/x"
    assert log["httpCode"] == "404"
    assert log["version"] == "7.106.1"
    assert log["__tag__:__client_ip__"] == "1.2.3.4"
    assert "rsd" not in log
    assert "noise_field" not in log
    assert "__tag__:__pack_id__" not in log


def test_cloud_search_from_is_offset_not_page(tmp_path) -> None:
    """from 从 0 起（偏移量），非页码。"""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["from"] = request.url.params.get("from")
        return httpx.Response(200, content=_cl_body({"data": {"logs": [], "total": 0}}))

    server = _make_server(_settings(tmp_path), handler)
    asyncio.run(_call(server, "cloud_search", {"topic": "t1", "time": "15m", "from_": 100}))
    assert captured["from"] == "100"


def test_cloud_probe_returns_accessibility(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_cl_body(
                {
                    "data": {"success": True, "logstores": ["t1", "t2"]},
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(
        _call(
            server,
            "cloud_probe",
            {
                "region": "cn-beijing",
                "account": "a1",
                "collection": "c1",
            },
        )
    )
    payload = json.loads(result.content[0].text)
    assert payload["accessible"] is True
    assert payload["topics"] == ["t1", "t2"]
    assert payload["region"] == "cn-beijing"
    assert "latency_ms" in payload


def test_cloud_vendor_tencent_rejected(tmp_path) -> None:
    server = _make_server(_settings(tmp_path), lambda r: httpx.Response(200))
    result = asyncio.run(_call(server, "cloud_accounts", {"vendor": "tencent"}))
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "bad_request"


def test_cloud_search_upstream_error(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b'{"code":1,"msg":"err"}')

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "cloud_search", {"topic": "t1", "time": "15m"}))
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "upstream"
    assert payload["error"]["upstream"]["side"] == "cloud"
    assert payload["error"]["upstream"]["topic"] == "t1"
