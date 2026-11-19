"""云日志 6 个工具注册。

工具契约见方案 3.8.2。坐标 5 元组：vendor + account + collection + topic + region。
前 4 个有配置默认值（启动时注入 schema default），topic 动态。
当前仅支持阿里云 SLS；vendor=tencent 在工具层报错。
"""

from __future__ import annotations

from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from log_mcp.auth_context import require_scope
from log_mcp.clients.cloudlog import UpstreamError
from log_mcp.clients.redact import redact
from log_mcp.clients.time_range import TIME_PARAM_DESCRIPTION, parse_time_range
from log_mcp.config import CloudLogDefaults
from log_mcp.errors import LogMcpToolError

READ_ONLY = ToolAnnotations(read_only_hint=True)

# 云日志精简字段白名单（与日志中心各自维护；基于 prod-ios / prod-cloudlearn 真实样本）
# 真正白名单：不再「非 __ 全放行」。冗余大字段（rsd）与内部 tag 不放行。
_CLOUD_COMPACT_FIELDS = (
    # 坐标 / 时间
    "__time__",
    "__TIMESTAMP__",
    "__source__",
    "__topic__",
    "__tag__:__client_ip__",
    # 业务主字段（H5 / 埋点）
    "uid",
    "user_id",
    "eventid",
    "eventname",
    "customtraceid",
    "timestamp",
    "status",
    "desc",
    "pageid",
    "appid",
    "clickid",
    "exception",
    "currenthref",
    "ua",
    "env",
    "core",
    "gid",
    "sn",
    "level",
    "message",
    # 网络 APM
    "traceId",
    "requestUrl",
    "httpType",
    "httpCode",
    "requestStatus",
    "monitorLogType",
    "cc",
    # 设备 / 页面上下文
    "version",
    "buildVersion",
    "app_ver",
    "OS",
    "osVersion",
    "os_vers",
    "model",
    "device_id",
    "dev_id",
    "manufacturer",
    "page_path",
    "page_name",
    "lifecycle",
    "source",
    "bundleName",
    "appName",
    "packageName",
    "biztype",
    "channel",
    "clientType",
    "city",
    "cityCode",
    "durationMs",
    "stage",
    "modelType",
    "from",
    "initialMode",
    "guid",
)


def _resolve_range(time: str | None) -> tuple[int, int]:
    parsed = parse_time_range(time or "15m")
    if parsed is None:
        raise LogMcpToolError("bad_request", f"无效的时间范围: {time!r}")
    return parsed


def _upstream_error(exc: Exception, *, topic: str | None = None) -> LogMcpToolError:
    if isinstance(exc, UpstreamError):
        upstream: dict[str, Any] = {"side": "cloud"}
        if topic is not None:
            upstream["topic"] = topic
        if exc.status is not None:
            upstream["status"] = exc.status
        return LogMcpToolError("upstream", str(exc), upstream=upstream)
    return LogMcpToolError("internal", str(exc))


def _compact_cloud_log(log: dict[str, Any]) -> dict[str, Any]:
    """云日志精简投影：只保留白名单字段。"""
    return {k: log[k] for k in _CLOUD_COMPACT_FIELDS if k in log}


def register_cloudlog_tools(
    server: MCPServer,
    *,
    client_factory,
    defaults: CloudLogDefaults,
) -> None:
    """注册云日志 6 个工具。

    `client_factory() -> CloudLogClient`：云日志凭据与日志中心共用一对 appid/appsecret。
    `defaults`：启动时注入 schema default 的 4 个坐标。
    """

    vendor_default = "aliyun"

    @server.tool(
        name="cloud_accounts",
        description=(
            "列出某 vendor 下的云日志账号。"
            "日常用不到（account 已在配置里），保留供跨账号场景。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def cloud_accounts(
        vendor: Annotated[
            str, Field(description="aliyun（默认）/ tencent（当前报错）")
        ] = vendor_default,
    ) -> dict[str, Any]:
        require_scope("cloud_accounts")
        if vendor != "aliyun":
            raise LogMcpToolError("bad_request", f"当前仅支持阿里云 SLS，vendor={vendor} 不支持")
        client = client_factory()
        try:
            data = await client.accounts(vendor)
        except UpstreamError as exc:
            raise _upstream_error(exc) from exc
        return {"source": "cloud", "vendor": vendor, **data}

    @server.tool(
        name="cloud_collections",
        description="列出某账号下的日志集（SLS project）。日常用不到，保留供跨 collection 场景。",
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def cloud_collections(
        account: Annotated[str, Field(min_length=1, description="账号 ID（覆盖配置默认时必传）")],
        vendor: Annotated[
            str, Field(description="aliyun（默认）/ tencent（当前报错）")
        ] = vendor_default,
    ) -> dict[str, Any]:
        require_scope("cloud_collections")
        if vendor != "aliyun":
            raise LogMcpToolError("bad_request", f"当前仅支持阿里云 SLS，vendor={vendor} 不支持")
        client = client_factory()
        try:
            data = await client.collections(account=account, vendor=vendor)
        except UpstreamError as exc:
            raise _upstream_error(exc) from exc
        return {"source": "cloud", "vendor": vendor, "account": account, **data}

    @server.tool(
        name="cloud_topics",
        description=(
            "列出某账号下的全部 topic，每条自带 collection / region，无需先调 cloud_collections。"
            "不传 collection 时返回该账号全部 topic。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def cloud_topics(
        account: Annotated[str, Field(min_length=1, description="账号 ID")],
        collection: Annotated[str | None, Field(description="可选过滤")] = None,
        vendor: Annotated[
            str, Field(description="aliyun（默认）/ tencent（当前报错）")
        ] = vendor_default,
    ) -> dict[str, Any]:
        require_scope("cloud_topics")
        if vendor != "aliyun":
            raise LogMcpToolError("bad_request", f"当前仅支持阿里云 SLS，vendor={vendor} 不支持")
        client = client_factory()
        try:
            data = await client.topics(account=account, collection=collection, vendor=vendor)
        except UpstreamError as exc:
            raise _upstream_error(exc) from exc
        return {"source": "cloud", "vendor": vendor, "account": account, **data}

    @server.tool(
        name="cloud_count",
        description=(
            "统计某 topic 日志总量。不支持 query 过滤（官方 API 端点只接收坐标与时间）；"
            "需要带条件统计时请用 cloud_search 的 total。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def cloud_count(
        topic: Annotated[str, Field(min_length=1, description="主题 ID")],
        time: Annotated[str, Field(description=TIME_PARAM_DESCRIPTION)] = "15m",
        vendor: Annotated[
            str, Field(description="aliyun（默认）/ tencent（当前报错）")
        ] = vendor_default,
        account: Annotated[str, Field(description="账号 ID")] = defaults.account,
        collection: Annotated[str, Field(description="集合 ID")] = defaults.collection,
        region: Annotated[
            str, Field(description="地域，跨 region 时由调用方显式传")
        ] = defaults.region,
    ) -> dict[str, Any]:
        require_scope("cloud_count")
        if vendor != "aliyun":
            raise LogMcpToolError("bad_request", f"当前仅支持阿里云 SLS，vendor={vendor} 不支持")
        start, end = _resolve_range(time)
        client = client_factory()
        try:
            total = await client.count(
                vendor=vendor,
                region=region,
                account=account,
                collection=collection,
                topic=topic,
                start=start,
                end=end,
            )
        except UpstreamError as exc:
            raise _upstream_error(exc, topic=topic) from exc
        return {
            "source": "cloud",
            "vendor": vendor,
            "account": account,
            "collection": collection,
            "topic": topic,
            "region": region,
            "time": time,
            "start": start,
            "end": end,
            "total": total,
        }

    @server.tool(
        name="cloud_search",
        description=(
            "检索云日志内容。默认用关键词 query（如学员 uid、事件名），不要写 | select *；"
            "默认 full=true 返回全字段（仍脱敏）。from 从 0 起（偏移量，非页码）；时间用秒（__time__）。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def cloud_search(
        topic: Annotated[str, Field(min_length=1, description="主题 ID")],
        time: Annotated[str, Field(description=TIME_PARAM_DESCRIPTION)] = "15m",
        query: Annotated[
            str,
            Field(
                description=(
                    "检索条件，默认关键词。查人相关传学员 uid 裸数字（如 5570040），不要学员编号/card，不要 uid:/card: 字段语法。"
                    "日常排查不要用 | select * / select … from log；字段直接靠 full=true。"
                )
            ),
        ] = "*",
        size: Annotated[int, Field(ge=1, le=1000, description="每页条数，最大 1000")] = 100,
        from_: Annotated[int, Field(ge=0, description="偏移量（非页码）")] = 0,
        reverse: Annotated[bool, Field(description="是否倒序")] = False,
        full: Annotated[bool, Field(description="是否返回完整日志条目；排查默认 true")] = True,
        vendor: Annotated[
            str, Field(description="aliyun（默认）/ tencent（当前报错）")
        ] = vendor_default,
        account: Annotated[str, Field(description="账号 ID")] = defaults.account,
        collection: Annotated[str, Field(description="集合 ID")] = defaults.collection,
        region: Annotated[str, Field(description="地域")] = defaults.region,
    ) -> dict[str, Any]:
        require_scope("cloud_search")
        if vendor != "aliyun":
            raise LogMcpToolError("bad_request", f"当前仅支持阿里云 SLS，vendor={vendor} 不支持")
        start, end = _resolve_range(time)
        client = client_factory()
        try:
            result = await client.search(
                vendor=vendor,
                region=region,
                account=account,
                collection=collection,
                topic=topic,
                start=start,
                end=end,
                query=query,
                size=size,
                from_=from_,
                reverse=reverse,
            )
        except UpstreamError as exc:
            raise _upstream_error(exc, topic=topic) from exc
        logs = result["logs"]
        rows = logs if full else [_compact_cloud_log(log) for log in logs]
        return {
            "source": "cloud",
            "vendor": vendor,
            "account": account,
            "collection": collection,
            "topic": topic,
            "region": region,
            "time": time,
            "start": start,
            "end": end,
            "total": result["total"],
            "progress": result.get("progress"),
            "elapsed_ms": result.get("elapsed_ms"),
            "count": len(rows),
            "logs": redact(rows),
        }

    @server.tool(
        name="cloud_probe",
        description=(
            "探测某 collection 在某 region 的可访问性与延迟。region 必填（无配置默认）。"
            "返回 {source, accessible, vendor, region, account, collection, latency_ms, topics[]}。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def cloud_probe(
        region: Annotated[str, Field(min_length=1, description="地域（必填，无配置默认）")],
        account: Annotated[str, Field(min_length=1, description="账号 ID")],
        collection: Annotated[str, Field(min_length=1, description="集合 ID")],
        vendor: Annotated[
            str, Field(description="aliyun（默认）/ tencent（当前报错）")
        ] = vendor_default,
    ) -> dict[str, Any]:
        require_scope("cloud_probe")
        if vendor != "aliyun":
            raise LogMcpToolError("bad_request", f"当前仅支持阿里云 SLS，vendor={vendor} 不支持")
        client = client_factory()
        try:
            data = await client.probe(
                vendor=vendor,
                region=region,
                account=account,
                collection=collection,
            )
        except UpstreamError as exc:
            raise _upstream_error(exc) from exc
        return {"source": "cloud", **data}
