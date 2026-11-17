"""日志中心 7 个工具测试：用 MockTransport 模拟上游，验证返回结构与脱敏。"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from log_mcp.config import Settings
from log_mcp.server import LogMcpServer, _build_factories
from log_mcp.tools.logcenter import register_logcenter_tools
from tests.conftest import make_settings


def _settings(tmp_path) -> Settings:
    return make_settings(tmp_path)


def _lc_body(body: dict[str, Any]) -> bytes:
    return json.dumps({"code": 0, "msg": "ok", **body}).encode()


def _make_server(settings: Settings, handler) -> LogMcpServer:
    transport = httpx.MockTransport(handler)
    logcenter_factory, _ = _build_factories(settings, transport=transport)
    server = LogMcpServer(name="test-lc")
    register_logcenter_tools(server, client_factory=logcenter_factory)
    return server


async def _call(server: LogMcpServer, name: str, args: dict[str, Any]):
    return await server.call_tool(name, args)


def test_search_services_authorized_found(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "data": {
                        "list": [{"id": 6111, "name": "svc", "topic": "t"}],
                        "total": 1,
                        "total_page": 1,
                        "page": 1,
                        "size": 100,
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "search_services", {"keyword": "svc"}))
    payload = json.loads(result.content[0].text)
    assert payload["source"] == "logcenter"
    assert payload["result_type"] == "authorized_found"
    assert payload["services"][0]["id"] == 6111


def test_search_services_unauthorized_found(tmp_path) -> None:
    state = {"call": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["call"] += 1
        if state["call"] == 1:
            return httpx.Response(200, content=_lc_body({"data": {"list": []}}))
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "data": {"list": [{"id": 1, "name": "n", "topic": "t"}], "total": 1},
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "search_services", {"keyword": "no-perm"}))
    payload = json.loads(result.content[0].text)
    assert payload["result_type"] == "unauthorized_found"


def test_search_services_not_found(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_lc_body({"data": {"list": []}}))

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "search_services", {"keyword": "ghost"}))
    payload = json.loads(result.content[0].text)
    assert payload["result_type"] == "not_found"


def test_count_returns_total(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_lc_body({"total": 42}))

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "count", {"serviceId": 6111, "time": "15m"}))
    payload = json.loads(result.content[0].text)
    assert payload["source"] == "logcenter"
    assert payload["total"] == 42
    assert payload["service_id"] == 6111
    assert "logs" not in payload


def test_query_redacts_and_compact(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "total": 1,
                    "data": {
                        "data": [
                            {
                                "@timestamp": 1,
                                "message": "hi",
                                "token": "s",
                                "extra_field": "should_not_appear_in_compact",
                                "logsev_h": "noise",
                                "log_byte_size": "999",
                            }
                        ]
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "query", {"serviceId": 6111, "time": "15m", "full": False}))
    payload = json.loads(result.content[0].text)
    log = payload["logs"][0]
    # compact 模式按白名单过滤：敏感/噪声字段丢弃，排障字段保留
    assert "token" not in log
    assert "extra_field" not in log
    assert "logsev_h" not in log
    assert "log_byte_size" not in log
    assert log["message"] == "hi"
    assert "@timestamp" in log


def test_query_compact_keeps_apm_and_h5_fields(tmp_path) -> None:
    """客户端 APM / H5 日志字段需进入精简白名单；超大 performance 细节裁掉。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "total": 2,
                    "data": {
                        "data": [
                            {
                                "@timestamp": "2026-11-17T00:00:00Z",
                                "i": "24966209",
                                "rip": "1.2.3.4",
                                "stimestamp": "1",
                                "requestTime": "t",
                                "log_type": "basiclog-monitor",
                                "c": {
                                    "monitorLogType": "1",
                                    "pp": {"uid": "24966209", "ver": "7.1.0"},
                                    "netWorkLogEntity": {"requestUrl": "https://x", "httpCode": 200},
                                },
                                "@metadata": "drop-me",
                                "logsev_h": "drop-me",
                            },
                            {
                                "@timestamp": "2026-11-17T00:00:01Z",
                                "appid": "1005384",
                                "pageid": "英语绘本馆",
                                "ua": "XesApp",
                                "referrer": "https://ref",
                                "userid": "u1",
                                "data": {
                                    "eventid": "english-library-fe",
                                    "currenthref": "https://h5",
                                    "status": 200,
                                    "performanceResourceTiming": {"duration": 401, "name": "huge"},
                                },
                                "__SOURCE__": "drop-me",
                                "_id": "drop-me",
                            },
                        ]
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "query", {"serviceId": 6111, "time": "15m", "full": False}))
    payload = json.loads(result.content[0].text)
    apm, h5 = payload["logs"]

    assert apm["i"] == "24966209"
    assert apm["c"]["pp"]["uid"] == "24966209"
    assert apm["rip"] == "1.2.3.4"
    assert "logsev_h" not in apm
    assert "@metadata" not in apm

    assert h5["appid"] == "1005384"
    assert h5["pageid"] == "英语绘本馆"
    assert h5["data"]["eventid"] == "english-library-fe"
    assert "performanceResourceTiming" not in h5["data"]
    assert "__SOURCE__" not in h5
    assert "_id" not in h5


def test_query_full_keeps_all_fields_but_redacts(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "total": 1,
                    "data": {"data": [{"@timestamp": 1, "extra_field": "keep", "token": "s"}]},
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "query", {"serviceId": 6111, "time": "15m", "full": True}))
    payload = json.loads(result.content[0].text)
    log = payload["logs"][0]
    assert log["extra_field"] == "keep"
    assert log["token"] == "<redacted>"


def test_dsl_search_returns_hits_with_redact(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "data": {
                        "hits": {
                            "total": 1,
                            "hits": [
                                {
                                    "_index": "idx",
                                    "_id": "1",
                                    "_source": {"@timestamp": 1700000000000, "token": "s"},
                                },
                            ],
                        }
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(
        _call(
            server,
            "dsl_search",
            {
                "serviceId": 6111,
                "dsl": {"query": {"match_all": {}}},
            },
        )
    )
    payload = json.loads(result.content[0].text)
    assert payload["source"] == "logcenter"
    assert payload["total"] == 1
    assert payload["hits"][0]["_source"]["token"] == "<redacted>"


def test_dsl_search_rejects_script(tmp_path) -> None:
    server = _make_server(_settings(tmp_path), lambda r: httpx.Response(200, content=b"{}"))
    result = asyncio.run(
        _call(
            server,
            "dsl_search",
            {
                "serviceId": 6111,
                "dsl": {"script": {"source": "1"}},
            },
        )
    )
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "bad_request"


def test_upstream_error_returns_upstream_code(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(504, content=b'{"code":1,"msg":"timeout"}')

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "count", {"serviceId": 6111, "time": "15m"}))
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "upstream"
    assert payload["error"]["upstream"]["side"] == "logcenter"
    assert payload["error"]["upstream"]["service_id"] == 6111


def test_get_storage_type(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "data": {"storage_type": "ES", "alias": "es"},
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "get_storage_type", {"serviceId": 6111}))
    payload = json.loads(result.content[0].text)
    assert payload["alias"] == "es"
    assert payload["is_cloud_storage"] is False


def test_get_fields(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
                {
                    "data": {
                        "list": [
                            {
                                "id": 6111,
                                "name": "svc",
                                "mappings": [
                                    {"name": "level", "type": "keyword", "index": True},
                                    {"name": "internal", "type": "text", "index": False},
                                ],
                            }
                        ]
                    },
                }
            ),
        )

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "get_fields", {"serviceId": 6111}))
    payload = json.loads(result.content[0].text)
    assert payload["found"] is True
    names = [f["name"] for f in payload["fields"]]
    assert "level" in names
    assert "internal" not in names  # index=False 被过滤


def test_list_services(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_lc_body(
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

    server = _make_server(_settings(tmp_path), handler)
    result = asyncio.run(_call(server, "list_services", {"permission": "authorized"}))
    payload = json.loads(result.content[0].text)
    assert payload["total"] == 1
    assert payload["services"][0]["id"] == 1


def test_invalid_time_range_returns_bad_request(tmp_path) -> None:
    server = _make_server(_settings(tmp_path), lambda r: httpx.Response(200, content=b"{}"))
    result = asyncio.run(_call(server, "count", {"serviceId": 6111, "time": "not a time"}))
    assert result.is_error is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "bad_request"
