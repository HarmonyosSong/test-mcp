"""聚合工具 search_both_logs 测试：并行 + 单侧/单 topic 失败隔离。

用 httpx.MockTransport 模拟日志中心与云日志上游，验证：
  - 不传 cloud 时只查日志中心
  - 传 {} 时强制用配置坐标（account/collection）扫该集合下 topic
  - serviceId 与 keyword 优先级（serviceId 胜出）
  - 单 service / 单 topic 失败 → partial_failures，其余照常返回
  - 空 service / 空 topic 不进 results
  - max_services / max_topics 超限 → truncated
  - 两侧全部失败才 isError: true
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from log_mcp.config import Settings
from log_mcp.server import LogMcpServer
from tests.conftest import make_settings


def _settings(tmp_path) -> Settings:
    return make_settings(tmp_path)


def _make_transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def _logcenter_response(body: dict[str, Any]) -> bytes:
    return json.dumps({"code": 0, "msg": "ok", **body}).encode()


def test_search_both_logs_logcenter_only(tmp_path) -> None:
    """不传 cloud → 只查日志中心，cloud 字段为 None。"""

    def handler(request: httpx.Request) -> httpx.Response:
        # search_services → list
        if "/skill/service/list/v2" in str(request.url):
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "list": [{"id": 6111, "name": "svc-a"}],
                            "total": 1,
                            "total_page": 1,
                            "page": 1,
                            "size": 100,
                        },
                    }
                ),
            )
        # search → logs
        if "/skill/search" in str(request.url):
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "total": 5,
                        "data": {"data": [{"@timestamp": 1, "message": "phone 13800001111"}]},
                    }
                ),
            )
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)

    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {
                "keyword": "svc-a",
                "time": "15m",
            },
        )
    )
    assert result.is_error is False
    payload = json.loads(result.content[0].text)
    assert payload["cloud"] is None
    assert payload["logcenter"]["matched_services"] == 1
    assert payload["logcenter"]["results"][0]["service_id"] == 6111
    # 脱敏生效（compact 白名单字段 message 里的手机号被替换）
    assert payload["logcenter"]["results"][0]["logs"][0]["message"] == "phone <phone>"
    assert payload["partial_failures"] == []


def test_search_both_logs_cloud_empty_dict_uses_fixed_coordinates(tmp_path) -> None:
    """传 cloud={} → 强制配置坐标列 topic（忽略入参里的 account/collection）。"""
    seen_topics_collection: list[str | None] = []
    seen_topics_account: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/skill/service/list/v2" in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "list": [{"id": 6111, "name": "svc-a"}],
                            "total": 1,
                            "total_page": 1,
                            "page": 1,
                            "size": 100,
                        },
                    }
                ),
            )
        if "/skill/search" in url and "/skill/search/time" not in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "total": 0,
                        "data": {"data": []},
                    }
                ),
            )
        if "/skill/cloud/topics" in url:
            seen_topics_collection.append(request.url.params.get("collection_id"))
            seen_topics_account.append(request.url.params.get("account_ak_id"))
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "topics": [
                                {
                                    "topic_id": "t1",
                                    "collection_id": "pysy-front-log",
                                    "region": "cn-beijing",
                                    "vendor": "aliyun",
                                },
                                {
                                    "topic_id": "t2",
                                    "collection_id": "pysy-front-log",
                                    "region": "cn-beijing",
                                    "vendor": "aliyun",
                                },
                            ],
                            "total": 2,
                        },
                    }
                ),
            )
        if "/skill/cloud/aliyun/search" in url:
            topic = request.url.params.get("topic_id")
            if topic == "t1":
                return httpx.Response(
                    200,
                    content=_logcenter_response(
                        {
                            "data": {
                                "logs": [{"__time__": 1, "message": "phone 13800001111"}],
                                "total": 3,
                                "progress": "Complete",
                            },
                        }
                    ),
                )
            # t2 total=0 → 不进 results
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {"logs": [], "total": 0, "progress": "Complete"},
                    }
                ),
            )
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)

    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
        cloud_vendor=settings.cloudlog.vendor,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {
                "keyword": "svc-a",
                "time": "15m",
                # 即使乱传坐标，也应被配置坐标覆盖
                "cloud": {
                    "account": "wrong-account",
                    "collection": "wrong-collection",
                    "vendor": "tencent",
                },
            },
        )
    )
    payload = json.loads(result.content[0].text)
    assert seen_topics_collection == [settings.cloudlog.defaults.collection]
    assert seen_topics_account == [settings.cloudlog.defaults.account]
    assert payload["cloud"]["scanned_topics"] == 2
    assert payload["cloud"]["matched_topics"] == 1  # 只有 t1 有命中
    assert payload["cloud"]["results"][0]["topic"] == "t1"
    # 脱敏生效（compact 白名单字段 message 里的手机号被替换）
    assert payload["cloud"]["results"][0]["logs"][0]["message"] == "phone <phone>"
    # 日志中心侧 total=0 → 不进 results
    assert payload["logcenter"]["matched_services"] == 0


def test_search_both_logs_inherits_top_query_into_empty_cloud(tmp_path) -> None:
    """cloud={} 时，云侧 query 直接代入顶层 query，而不是默认 *。"""
    seen_cloud_queries: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/skill/service/list/v2" in url:
            return httpx.Response(
                200,
                content=_logcenter_response({"data": {"list": [], "total": 0, "total_page": 0}}),
            )
        if "/skill/cloud/topics" in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "topics": [
                                {
                                    "topic_id": "prod-ios",
                                    "collection_id": "pysy-front-log",
                                    "region": "cn-beijing",
                                    "vendor": "aliyun",
                                }
                            ],
                            "total": 1,
                        },
                    }
                ),
            )
        if "/skill/cloud/aliyun/search" in url:
            seen_cloud_queries.append(request.url.params.get("query"))
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "logs": [
                                {
                                    "__time__": 1,
                                    "message": "hit",
                                    "non_whitelist_field": "keep-me",
                                }
                            ],
                            "total": 1,
                            "progress": "Complete",
                        }
                    }
                ),
            )
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)
    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
        cloud_vendor=settings.cloudlog.vendor,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {"time": "7d", "query": "sample-query", "cloud": {}},
        )
    )
    payload = json.loads(result.content[0].text)
    assert seen_cloud_queries == ["sample-query"]
    assert payload["cloud"]["matched_topics"] == 1
    # cloud={} 默认 full=false：非白名单字段应被丢掉
    assert "non_whitelist_field" not in payload["cloud"]["results"][0]["logs"][0]
    assert payload["cloud"]["results"][0]["logs"][0]["message"] == "hit"


def test_serviceid_overrides_keyword(tmp_path) -> None:
    """serviceId 与 keyword 同时传时以 serviceId 为准。"""

    requested = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/skill/service/list/v2" in url:
            requested["searched"] = True
            return httpx.Response(200, content=_logcenter_response({"data": {"list": []}}))
        if "/skill/search" in url and "/skill/search/time" not in url:
            sid = request.url.params.get("service_id")
            requested["service_id"] = sid
            return httpx.Response(
                200,
                content=_logcenter_response({"total": 1, "data": {"data": [{"@timestamp": 1}]}}),
            )
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)

    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {
                "keyword": "ignored",
                "serviceId": 999,
                "time": "15m",
            },
        )
    )
    assert result.is_error is False
    assert requested.get("service_id") == "999"
    assert "searched" not in requested  # 没调 search_services


def test_single_topic_failure_isolated(tmp_path) -> None:
    """单 topic 失败 → partial_failures，其余照常返回。"""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/skill/cloud/topics" in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "topics": [
                                {"topic_id": "good", "collection_id": "c", "region": "r"},
                                {"topic_id": "bad", "collection_id": "c", "region": "r"},
                            ],
                            "total": 2,
                        },
                    }
                ),
            )
        if "/skill/cloud/aliyun/search" in url:
            topic = request.url.params.get("topic_id")
            if topic == "bad":
                return httpx.Response(504, content=b'{"code":1,"msg":"gateway timeout"}')
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {"logs": [{"__time__": 1}], "total": 2, "progress": "Complete"},
                    }
                ),
            )
        if "/skill/service/list/v2" in url:
            return httpx.Response(200, content=_logcenter_response({"data": {"list": []}}))
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)

    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {
                "keyword": "x",
                "time": "15m",
                "cloud": {},
            },
        )
    )
    payload = json.loads(result.content[0].text)
    assert payload["cloud"]["matched_topics"] == 1
    assert len(payload["partial_failures"]) == 1
    assert payload["partial_failures"][0]["topic"] == "bad"
    assert payload["partial_failures"][0]["error"]["code"] == "upstream"


def test_max_topics_truncation(tmp_path) -> None:
    """topic 数超 max_topics → truncated.topics_skipped > 0。"""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/skill/cloud/topics" in url:
            topics = [{"topic_id": f"t{i}", "collection_id": "c", "region": "r"} for i in range(5)]
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {"topics": topics, "total": 5},
                    }
                ),
            )
        if "/skill/cloud/aliyun/search" in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {"logs": [{"__time__": 1}], "total": 1, "progress": "Complete"},
                    }
                ),
            )
        if "/skill/service/list/v2" in url:
            return httpx.Response(200, content=_logcenter_response({"data": {"list": []}}))
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)

    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {
                "keyword": "x",
                "time": "15m",
                "cloud": {},
                "max_topics": 2,
            },
        )
    )
    payload = json.loads(result.content[0].text)
    assert payload["cloud"]["scanned_topics"] == 2
    assert payload["truncated"]["topics_skipped"] == 3


def test_no_keyword_no_serviceid_logcenter_error(tmp_path) -> None:
    """keyword 与 serviceId 皆无 → 日志中心侧报错，云日志侧不受影响。"""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/skill/cloud/topics" in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {
                            "topics": [{"topic_id": "t", "collection_id": "c", "region": "r"}],
                            "total": 1,
                        },
                    }
                ),
            )
        if "/skill/cloud/aliyun/search" in url:
            return httpx.Response(
                200,
                content=_logcenter_response(
                    {
                        "data": {"logs": [{"__time__": 1}], "total": 1, "progress": "Complete"},
                    }
                ),
            )
        return httpx.Response(404)

    settings = _settings(tmp_path)
    transport = _make_transport(handler)
    from log_mcp.server import _build_factories

    logcenter_factory, cloudlog_factory = _build_factories(settings, transport=transport)

    server = LogMcpServer(name="test")
    from log_mcp.tools.aggregate import register_aggregate_tools

    register_aggregate_tools(
        server,
        logcenter_factory=logcenter_factory,
        cloudlog_factory=cloudlog_factory,
        cloud_defaults=settings.cloudlog.defaults,
    )

    result = asyncio.run(
        _call_tool(
            server,
            "search_both_logs",
            {
                "time": "15m",
                "cloud": {},
            },
        )
    )
    payload = json.loads(result.content[0].text)
    # 日志中心侧 partial_failure
    assert len(payload["partial_failures"]) == 1
    assert payload["partial_failures"][0]["side"] == "logcenter"
    assert payload["partial_failures"][0]["error"]["code"] == "bad_request"
    # 云日志侧仍成功
    assert payload["cloud"]["matched_topics"] == 1


async def _call_tool(server: LogMcpServer, name: str, args: dict[str, Any]):
    """直接调 call_tool，绕过 MCP 协议层。"""
    return await server.call_tool(name, args)

# ———— 上下文体积护栏：字段值截断 + 总字符预算 ————


def test_clip_strings_recursively() -> None:
    """单条字段值超 600 字符被截断，结构保留。"""
    from log_mcp.tools.aggregate import _clip_strings

    long_value = "x" * 1_000
    clipped = _clip_strings(
        {"a": long_value, "b": ["short", long_value], "c": {"d": long_value}, "e": 42}
    )
    assert clipped["a"].endswith("…") and len(clipped["a"]) == 600
    assert clipped["b"][0] == "short"
    assert clipped["b"][1].endswith("…")
    assert clipped["c"]["d"].endswith("…")
    assert clipped["e"] == 42


def test_trim_logs_budget_omits_and_marks() -> None:
    """总预算超限时裁掉溢出日志，分组标注 logs_omitted，且每组至少保住首条。"""
    from log_mcp.tools.aggregate import _trim_logs_budget

    results = [
        {"logs": [{"m": "a" * 500} for _ in range(10)]},
        {"logs": [{"m": "b" * 500} for _ in range(10)]},
    ]
    omitted = _trim_logs_budget(results, budget=1_500)
    assert omitted > 0
    assert results[0]["logs"], "首组至少保留首条"
    assert results[1]["logs"], "后续组也保住首条"
    for group in results:
        if len(group["logs"]) < 10:
            assert group["logs_omitted"] == 10 - len(group["logs"])

