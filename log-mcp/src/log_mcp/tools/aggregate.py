"""聚合工具 `search_both_logs`：两侧并行 + 单侧/单 topic 失败隔离。

唯一允许同时 import 日志中心与云日志两侧的模块（见方案 3.7.3）。
只调用客户端方法，不复制两侧工具逻辑，不归一化结果。
"""

from __future__ import annotations

import asyncio
import time
from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from log_mcp.auth_context import require_scope
from log_mcp.clients.cloudlog import CloudLogClient
from log_mcp.clients.cloudlog import UpstreamError as CloudUpstreamError
from log_mcp.clients.logcenter import LogCenterClient
from log_mcp.clients.logcenter import UpstreamError as LogUpstreamError
from log_mcp.clients.redact import redact
from log_mcp.clients.time_range import TIME_PARAM_DESCRIPTION, parse_time_range
from log_mcp.config import CloudLogDefaults, normalize_env
from log_mcp.errors import LogMcpToolError
from log_mcp.tools.cloudlog import _compact_cloud_log
from log_mcp.tools.compact_util import (
    LOGS_BUDGET_CHARS,
    VALUE_MAX_CHARS,
    clip_strings,
    trim_grouped_logs_budget,
)
from log_mcp.tools.logcenter import _compact_log, _normalize_services

READ_ONLY = ToolAnnotations(read_only_hint=True)

# 云日志侧并发上限（方案 3.5.5 ①）
_CLOUD_CONCURRENCY = 8

# —— 上下文体积护栏 ——
# 聚合工具是"广撒网"：命中只为定位去哪个 service/topic 精查。
# 单字段/总量上限与精查路径共用 compact_util。
_VALUE_MAX_CHARS = VALUE_MAX_CHARS
_LOGS_BUDGET_CHARS = LOGS_BUDGET_CHARS
_clip_strings = clip_strings
_trim_logs_budget = trim_grouped_logs_budget


def _resolve_range(time: str) -> tuple[int, int]:
    parsed = parse_time_range(time or "15m")
    if parsed is None:
        raise LogMcpToolError("bad_request", f"无效的时间范围: {time!r}")
    return parsed


def register_aggregate_tools(
    server: MCPServer,
    *,
    logcenter_factory,
    cloudlog_factory,
    cloud_defaults: CloudLogDefaults,
    default_env: str = "test",
    cloud_vendor: str = "aliyun",
) -> None:
    """注册 search_both_logs。

    `logcenter_factory(env) -> LogCenterClient`
    `cloudlog_factory() -> CloudLogClient`
    `cloud_defaults` / `cloud_vendor`：云日志固定坐标（查询时强制使用，不由入参改写）
    `default_env`：启动注入的默认环境，作为日志中心侧 `env` 入参缺省值
    """
    boot_env = normalize_env(default_env)

    @server.tool(
        name="search_both_logs",
        description=(
            "一次调用同时返回日志中心与云日志结果。"
            "云日志坐标固定为启动配置（vendor/account/collection），在该集合下遍历 topic。"
            "两侧平级、并行、互不依赖；任一侧或单 topic 失败不阻止其余返回。"
            "不传 cloud 时只查日志中心；传 cloud（含 {}）时按固定坐标查云日志。"
            "传了 cloud 但未写 cloud.query 时，自动复用顶层 query（避免 cloud={} 变成 query=* 扫全量）。"
            "serviceId 与 keyword 同时传时以 serviceId 为准。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def search_both_logs(
        time: Annotated[str, Field(description=f"两侧共用时间窗。{TIME_PARAM_DESCRIPTION}")],
        keyword: Annotated[
            str | None, Field(description="日志中心搜服务用（发现 service_id）")
        ] = None,
        serviceId: Annotated[
            int | None, Field(ge=1, description="已知 service_id 时直接查")
        ] = None,
        query: Annotated[
            str | None,
            Field(
                description=(
                    "检索条件。日志中心侧作 Lucene；云日志侧作关键词。"
                    "查人相关请传学员 uid 裸数字（如 5570040），不要传学员编号/card，不要写 uid:/card: 字段语法。"
                    "若同时传了 cloud 且未设置 cloud.query，则云日志侧也使用该值（勿只传 cloud={}）。"
                )
            ),
        ] = None,
        page: Annotated[int, Field(ge=1, description="日志中心页码（1 起）")] = 1,
        per_service_size: Annotated[
            int, Field(ge=1, le=200, description="每个命中 service 返回条数")
        ] = 20,
        cloud: Annotated[
            dict[str, Any] | None, Field(description="云日志参数，缺省即不查云日志")
        ] = None,
        max_services: Annotated[
            int, Field(ge=1, description="日志中心最多查多少个命中 service")
        ] = 10,
        max_topics: Annotated[int, Field(ge=1, description="云日志最多扫多少个 topic")] = 20,
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("search_both_logs")
        start, end = _resolve_range(time)
        logcenter_query = "" if (query is None or query == "*") else query

        logcenter_task = _run_logcenter(
            logcenter_factory=logcenter_factory,
            env=normalize_env(env),
            keyword=keyword,
            service_id=serviceId,
            start=start,
            end=end,
            query=logcenter_query,
            page=page,
            per_service_size=per_service_size,
            max_services=max_services,
        )

        if cloud is None:
            # 不传 cloud → 只查日志中心；云日志侧不执行
            logcenter_result = await logcenter_task
            return {
                "logcenter": logcenter_result,
                "cloud": None,
                "partial_failures": [],
                "truncated": {"services_skipped": 0, "topics_skipped": 0},
            }

        # 传了 cloud 但未给 cloud.query 时，直接代入顶层 query；否则云侧会默认成 *。
        cloud_params = dict(cloud)
        top_query = (query or "").strip()
        cloud_query = cloud_params.get("query")
        if top_query and top_query != "*" and not (
            isinstance(cloud_query, str) and cloud_query.strip() and cloud_query.strip() != "*"
        ):
            cloud_params["query"] = top_query

        cloud_task = _run_cloud_all_topics(
            cloudlog_factory=cloudlog_factory,
            defaults=cloud_defaults,
            vendor=cloud_vendor,
            cloud=cloud_params,
            start=start,
            end=end,
            max_topics=max_topics,
        )

        logcenter_result, cloud_result = await asyncio.gather(
            logcenter_task,
            cloud_task,
            return_exceptions=True,
        )
        # 两侧独立；任一抛错时另一侧结果仍返回（方案 3.5.0 ④）
        if isinstance(logcenter_result, Exception):
            logcenter_result = _logcenter_failure(logcenter_result)
        if isinstance(cloud_result, Exception):
            cloud_result = _cloud_failure(cloud_result)

        partial_failures: list[dict[str, Any]] = []
        partial_failures.extend(logcenter_result.get("partial_failures") or [])
        partial_failures.extend(cloud_result.get("partial_failures") or [])

        return {
            "logcenter": _strip_partial(logcenter_result),
            "cloud": _strip_partial(cloud_result),
            "partial_failures": partial_failures,
            "truncated": {
                "services_skipped": logcenter_result.get("truncated", {}).get("services_skipped", 0)
                + cloud_result.get("truncated", {}).get("services_skipped", 0),
                "topics_skipped": logcenter_result.get("truncated", {}).get("topics_skipped", 0)
                + cloud_result.get("truncated", {}).get("topics_skipped", 0),
                "logs_omitted": logcenter_result.get("truncated", {}).get("logs_omitted", 0)
                + cloud_result.get("truncated", {}).get("logs_omitted", 0),
            },
        }


def _strip_partial(result: dict[str, Any]) -> dict[str, Any]:
    """从一侧结果中去掉 partial_failures（已合并到顶层）。"""
    return {k: v for k, v in result.items() if k != "partial_failures"}


def _logcenter_failure(exc: Exception) -> dict[str, Any]:
    """日志中心侧整体失败时构造空结果 + partial_failure。"""
    error = _exception_to_error(exc, side="logcenter")
    return {
        "scanned_services": 0,
        "matched_services": 0,
        "results": [],
        "elapsed_ms": 0,
        "partial_failures": [{"side": "logcenter", "error": error}],
        "truncated": {"services_skipped": 0, "topics_skipped": 0},
    }


def _cloud_failure(exc: Exception) -> dict[str, Any]:
    """云日志侧整体失败时构造空结果 + partial_failure。"""
    error = _exception_to_error(exc, side="cloud")
    return {
        "scanned_topics": 0,
        "matched_topics": 0,
        "results": [],
        "elapsed_ms": 0,
        "partial_failures": [{"side": "cloud", "error": error}],
        "truncated": {"services_skipped": 0, "topics_skipped": 0},
    }


def _exception_to_error(exc: Exception, *, side: str) -> dict[str, Any]:
    """把异常转成 partial_failures 里的 error 结构。"""
    if isinstance(exc, LogMcpToolError):
        return {"code": exc.code, "message": exc.message, "upstream": exc.upstream}
    if isinstance(exc, (LogUpstreamError, CloudUpstreamError)):
        return {
            "code": "upstream",
            "message": str(exc),
            "upstream": {"side": side, "status": exc.status},
        }
    return {"code": "internal", "message": str(exc)}


async def _run_logcenter(
    *,
    logcenter_factory,
    env: str,
    keyword: str | None,
    service_id: int | None,
    start: int,
    end: int,
    query: str,
    page: int,
    per_service_size: int,
    max_services: int,
) -> dict[str, Any]:
    """日志中心侧：发现 service_id → 逐个查；按 service 分组返回。"""
    began = time.monotonic()
    client: LogCenterClient = logcenter_factory(env)

    # 发现 service_id 列表
    if service_id is not None:
        services = [{"id": service_id, "name": None, "topic": None}]
    elif keyword is not None:
        try:
            data = await client.search_services(keyword)
        except LogUpstreamError as exc:
            return _logcenter_failure_with(exc, began)
        services = [
            {"id": s.get("id"), "name": s.get("name"), "topic": s.get("topic")}
            for s in _normalize_services(data["list"])
        ]
    else:
        # 两侧皆无 → 日志中心侧报错（云日志侧不受影响）
        return {
            "scanned_services": 0,
            "matched_services": 0,
            "results": [],
            "elapsed_ms": int((time.monotonic() - began) * 1000),
            "partial_failures": [
                {
                    "side": "logcenter",
                    "error": {"code": "bad_request", "message": "keyword 或 serviceId 至少传一个"},
                }
            ],
            "truncated": {"services_skipped": 0, "topics_skipped": 0},
        }

    truncated_count = max(0, len(services) - max_services)
    services = services[:max_services]

    tasks = [
        _query_one_service(client, svc, start, end, query, page, per_service_size)
        for svc in services
    ]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for svc, outcome in zip(services, outcomes, strict=True):
        if isinstance(outcome, Exception):
            failures.append(
                {
                    "side": "logcenter",
                    "service_id": svc["id"],
                    "error": _exception_to_error(outcome, side="logcenter"),
                }
            )
            continue
        if outcome is None or outcome["total"] == 0:
            continue
        results.append(
            {
                "source": "logcenter",
                "service_id": svc["id"],
                "service_name": svc.get("name"),
                "total": outcome["total"],
                "logs": redact(_clip_strings(outcome["logs"])),
                "elapsed_ms": outcome["elapsed_ms"],
            }
        )

    logs_omitted = _trim_logs_budget(results)

    return {
        "scanned_services": len(services),
        "matched_services": len(results),
        "results": results,
        "elapsed_ms": int((time.monotonic() - began) * 1000),
        "partial_failures": failures,
        "truncated": {
            "services_skipped": truncated_count,
            "topics_skipped": 0,
            "logs_omitted": logs_omitted,
        },
    }


def _logcenter_failure_with(exc: Exception, began: float) -> dict[str, Any]:
    return {
        "scanned_services": 0,
        "matched_services": 0,
        "results": [],
        "elapsed_ms": int((time.monotonic() - began) * 1000),
        "partial_failures": [
            {
                "side": "logcenter",
                "error": _exception_to_error(exc, side="logcenter"),
            }
        ],
        "truncated": {"services_skipped": 0, "topics_skipped": 0},
    }


async def _query_one_service(
    client: LogCenterClient,
    svc: dict[str, Any],
    start: int,
    end: int,
    query: str,
    page: int,
    per_service_size: int,
) -> dict[str, Any] | None:
    """查单个 service；total==0 返回 None（不进 results）。"""
    began = time.monotonic()
    result = await client.search(svc["id"], start, end, query, page, per_service_size)
    logs = result["logs"]
    rows = [_compact_log(log) for log in logs]
    return {
        "total": result["total"],
        "logs": rows,
        "elapsed_ms": int((time.monotonic() - began) * 1000),
    }


async def _run_cloud_all_topics(
    *,
    cloudlog_factory,
    defaults: CloudLogDefaults,
    vendor: str,
    cloud: dict[str, Any],
    start: int,
    end: int,
    max_topics: int,
) -> dict[str, Any]:
    """云日志侧：固定配置坐标列 topic → 逐个 query；按 topic 分组返回。"""
    began = time.monotonic()
    client: CloudLogClient = cloudlog_factory()

    # 坐标固定取启动配置，忽略 cloud 入参里的 vendor/account/collection
    if vendor != "aliyun":
        return {
            "scanned_topics": 0,
            "matched_topics": 0,
            "results": [],
            "elapsed_ms": int((time.monotonic() - began) * 1000),
            "partial_failures": [
                {
                    "side": "cloud",
                    "error": {
                        "code": "bad_request",
                        "message": f"vendor={vendor} 当前不支持，仅 aliyun",
                    },
                }
            ],
            "truncated": {"services_skipped": 0, "topics_skipped": 0},
        }

    account = defaults.account
    collection_filter = defaults.collection
    query = cloud.get("query") or "*"
    per_topic_size = cloud.get("per_topic_size") or 10
    from_ = cloud.get("from") or 0
    reverse = bool(cloud.get("reverse", False))
    # 与 cloud_search 默认一致：广撒网默认 compact；细节靠后续精查。
    full = bool(cloud.get("full", False))

    try:
        topics_data = await client.topics(
            account=account, collection=collection_filter, vendor=vendor
        )
    except CloudUpstreamError as exc:
        return {
            "scanned_topics": 0,
            "matched_topics": 0,
            "results": [],
            "elapsed_ms": int((time.monotonic() - began) * 1000),
            "partial_failures": [
                {
                    "side": "cloud",
                    "vendor": vendor,
                    "error": _exception_to_error(exc, side="cloud"),
                }
            ],
            "truncated": {"services_skipped": 0, "topics_skipped": 0},
        }

    all_topics = topics_data["topics"]
    # 可指定单个 topic
    if cloud.get("topic"):
        all_topics = [t for t in all_topics if t.get("topic_id") == cloud["topic"]]

    truncated_topics = max(0, len(all_topics) - max_topics)
    all_topics = all_topics[:max_topics]

    semaphore = asyncio.Semaphore(_CLOUD_CONCURRENCY)

    async def _query_topic(topic: dict[str, Any]) -> dict[str, Any] | None:
        async with semaphore:
            return await _query_one_topic(
                client,
                topic=topic,
                vendor=vendor,
                account=account,
                region_default=defaults.region,
                collection_default=collection_filter,
                start=start,
                end=end,
                query=query,
                per_topic_size=per_topic_size,
                from_=from_,
                reverse=reverse,
                full=full,
            )

    tasks = [_query_topic(t) for t in all_topics]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for topic, outcome in zip(all_topics, outcomes, strict=True):
        topic_id = topic.get("topic_id")
        if isinstance(outcome, Exception):
            failures.append(
                {
                    "side": "cloud",
                    "vendor": vendor,
                    "topic": topic_id,
                    "error": _exception_to_error(outcome, side="cloud"),
                }
            )
            continue
        if outcome is None or outcome["total"] == 0:
            continue
        results.append(
            {
                "source": "cloud",
                "vendor": vendor,
                "account": account,
                "collection": topic.get("collection_id"),
                "topic": topic_id,
                "region": topic.get("region"),
                "total": outcome["total"],
                "logs": redact(_clip_strings(outcome["logs"])),
                "elapsed_ms": outcome["elapsed_ms"],
            }
        )

    logs_omitted = _trim_logs_budget(results)

    return {
        "scanned_topics": len(all_topics),
        "matched_topics": len(results),
        "results": results,
        "elapsed_ms": int((time.monotonic() - began) * 1000),
        "partial_failures": failures,
        "truncated": {
            "services_skipped": 0,
            "topics_skipped": truncated_topics,
            "logs_omitted": logs_omitted,
        },
    }


async def _query_one_topic(
    client: CloudLogClient,
    *,
    topic: dict[str, Any],
    vendor: str,
    account: str,
    region_default: str,
    collection_default: str,
    start: int,
    end: int,
    query: str,
    per_topic_size: int,
    from_: int,
    reverse: bool,
    full: bool,
) -> dict[str, Any] | None:
    """查单个 topic；total==0 返回 None。"""
    began = time.monotonic()
    result = await client.search(
        vendor=vendor,
        region=topic.get("region") or region_default,
        account=account,
        collection=topic.get("collection_id") or collection_default,
        topic=topic.get("topic_id") or "",
        start=start,
        end=end,
        query=query,
        size=per_topic_size,
        from_=from_,
        reverse=reverse,
    )
    logs = result["logs"]
    rows = logs if full else [_compact_cloud_log(log) for log in logs]
    return {
        "total": result["total"],
        "logs": rows,
        "elapsed_ms": int((time.monotonic() - began) * 1000),
    }
