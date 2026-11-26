"""日志中心 7 个工具注册。

工具契约见方案 3.8.1。每个工具只给 description + 参数表，返回结构由实现决定。
所有返回都带 `source: "logcenter"`，并过脱敏（见 4 节）。
"""

from __future__ import annotations

from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from log_mcp.auth_context import require_scope
from log_mcp.clients.logcenter import UpstreamError
from log_mcp.clients.redact import redact
from log_mcp.clients.time_range import TIME_PARAM_DESCRIPTION, parse_time_range
from log_mcp.config import normalize_env
from log_mcp.errors import LogMcpToolError
from log_mcp.tools.compact_util import (
    apply_budget_to_log_rows,
    scrub_currenthref,
    slim_response_field,
    summarize_ua,
    ua_excerpt,
)

READ_ONLY = ToolAnnotations(read_only_hint=True)

# DSL 中禁止的 key（任意层级），对齐 dev-agent-logs containsForbiddenKeys
_FORBIDDEN_DSL_KEYS = frozenset({"script", "script_fields"})

# 日志中心精简字段白名单（按真实生产样本：服务端 + 客户端 APM + H5）
# 不同端字段不可比，取并集；噪声字段（@metadata / logsev_h / _id 等）不放行。
_COMPACT_FIELDS = (
    # 服务端常见
    "@timestamp",
    "x_level",
    "level",
    "x_msg",
    "message",
    "x_module",
    "x_trace_id",
    "traceId",
    "service_name",
    "container_app_name",
    # 客户端 APM（846/847/1028 等）
    "i",  # 多端把 uid 放在此字段
    "c",  # pp / netWorkLogEntity / monitorLogType
    "l",
    "rip",
    "stimestamp",
    "requestTime",
    "log_type",
    # H5 / 前端埋点（6846 等）
    "appid",
    "clientid",
    "pageid",
    "referrer",
    "userid",
    "uvid",
    "version",
    "data",
    "accessMode",
    "clits",
    "xesid",
    "sessid",
)

# data 内体积过大且对排障价值低的子字段（response 正文另做 code/message 摘要）
_DATA_DROP_KEYS = frozenset({"performanceResourceTiming", "rsd"})
_DATA_KEEP_KEYS = frozenset(
    {
        "eventid",
        "traceid",
        "status",
        "method",
        "elapsedTime",
        "resourceUrl",
        "currenthref",
        "type",
        "effectiveType",
        "pageviewsize",
        "response",
    }
)
_C_PP_KEEP_KEYS = frozenset(
    {
        "uid",
        "clientIdentifier",
        "talDeviceID",
        "ver",
        "vn",
        "os",
        "devid",
        "dm",
        "lt",
    }
)
_C_JSBRIDGE_KEEP_KEYS = frozenset(
    {
        "eventid",
        "eventname",
        "desc",
        "status",
        "exception",
        "clickid",
        "customtraceid",
    }
)


def _resolve_range(time: str | None) -> tuple[int, int]:
    parsed = parse_time_range(time or "15m")
    if parsed is None:
        raise LogMcpToolError("bad_request", f"无效的时间范围: {time!r}")
    return parsed


def _upstream_error(exc: Exception, *, service_id: int | None = None) -> LogMcpToolError:
    """把 UpstreamError 转成方案 5.3.1 的 upstream 错误。"""
    if isinstance(exc, UpstreamError):
        upstream: dict[str, Any] = {"side": "logcenter"}
        if service_id is not None:
            upstream["service_id"] = service_id
        if exc.status is not None:
            upstream["status"] = exc.status
        return LogMcpToolError("upstream", str(exc), upstream=upstream)
    return LogMcpToolError("internal", str(exc))


def _compact_c_field(value: Any) -> Any:
    """客户端 APM 的 c：只留 monitorLogType + pp 设备子集 + jsBridge 事件摘要。"""
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    if "monitorLogType" in value:
        out["monitorLogType"] = value["monitorLogType"]
    if "infoType" in value:
        out["infoType"] = value["infoType"]
    pp = value.get("pp")
    if isinstance(pp, dict):
        slim_pp = {k: pp[k] for k in _C_PP_KEEP_KEYS if k in pp}
        if slim_pp:
            out["pp"] = slim_pp
    bridge = value.get("jsBridgeInfo")
    if isinstance(bridge, dict):
        slim_bridge = {k: bridge[k] for k in _C_JSBRIDGE_KEEP_KEYS if k in bridge}
        if slim_bridge:
            out["jsBridgeInfo"] = slim_bridge
    return out


def _compact_data_field(value: Any) -> Any:
    """H5 data：子白名单；response 仅 code/message；currenthref 去 token。"""
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, item in value.items():
        if key in _DATA_DROP_KEYS:
            continue
        if key not in _DATA_KEEP_KEYS:
            continue
        if key == "response":
            out[key] = slim_response_field(item)
        elif key == "currenthref":
            out[key] = scrub_currenthref(item)
        else:
            out[key] = item
    return out


def _compact_log(log: dict[str, Any]) -> dict[str, Any]:
    """精简字段白名单投影；保留排障必要字段，裁掉噪声与超大无用子树。"""
    out = {k: log[k] for k in _COMPACT_FIELDS if k in log and k not in {"ua", "c", "data"}}
    if "sys" in log:
        out["sys"] = log["sys"]
    if isinstance(log.get("bus"), dict) and "eventid" in log["bus"]:
        out["bus"] = {"eventid": log["bus"]["eventid"]}
    if "c" in log:
        out["c"] = _compact_c_field(log["c"])
    if "data" in log:
        out["data"] = _compact_data_field(log["data"])
    ua_summary = summarize_ua(log.get("ua"), (log.get("data") or {}).get("rsd") if isinstance(log.get("data"), dict) else None)
    if ua_summary:
        out["ua_summary"] = ua_summary
        for key, value in ua_summary.items():
            if key not in out or out.get(key) in (None, ""):
                out[key] = value
    else:
        # 摘要抽不出字段时保留极短占位（对齐云侧 P0-2），原文可 full=true 看。
        excerpt = ua_excerpt(log.get("ua"), (log.get("data") or {}).get("rsd") if isinstance(log.get("data"), dict) else None)
        if excerpt:
            out["ua_excerpt"] = excerpt
    return out


def _contains_forbidden_keys(value: Any) -> bool:
    """递归检查 DSL 是否包含禁止 key。"""
    if isinstance(value, dict):
        return any(
            str(k).lower() in _FORBIDDEN_DSL_KEYS or _contains_forbidden_keys(v)
            for k, v in value.items()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_keys(item) for item in value)
    return False


def _validate_dsl(dsl: Any, size: int | None, from_: int | None) -> tuple[int | None, int | None]:
    """DSL 输入校验，对齐方案 4.1。"""
    if not isinstance(dsl, dict):
        raise LogMcpToolError("bad_request", "DSL 必须是 JSON 对象")
    if _contains_forbidden_keys(dsl):
        raise LogMcpToolError("bad_request", "DSL 中不允许包含 script 或 script_fields")
    resolved_size = (
        size
        if size is not None
        else (
            dsl.get("size")
            if isinstance(dsl.get("size"), int) and not isinstance(dsl.get("size"), bool)
            else None
        )
    )
    resolved_from = (
        from_
        if from_ is not None
        else (
            dsl.get("from")
            if isinstance(dsl.get("from"), int) and not isinstance(dsl.get("from"), bool)
            else None
        )
    )
    if resolved_size is not None and not (0 <= resolved_size <= 200):
        raise LogMcpToolError("bad_request", "size 必须在 0 到 200 之间")
    if resolved_from is not None and resolved_from < 0:
        raise LogMcpToolError("bad_request", "from 不能小于 0")
    if (
        resolved_size is not None
        and resolved_from is not None
        and resolved_size + resolved_from > 10000
    ):
        raise LogMcpToolError("bad_request", "from + size 不能超过 10000，请改用 search_after")
    if resolved_from is not None and "search_after" in dsl:
        raise LogMcpToolError("bad_request", "from 与 DSL 中的 search_after 不能同时使用")
    return resolved_size, resolved_from


def register_logcenter_tools(
    server: MCPServer,
    *,
    client_factory,
    default_env: str = "test",
) -> None:
    """注册日志中心 7 个工具。

    `client_factory(env: str) -> LogCenterClient`：按 env 返回已配置凭据+网关的客户端。
    `default_env`：启动注入的默认环境（`LOG_MCP_ENV`），作为工具 `env` 入参缺省值。
    """
    boot_env = normalize_env(default_env)

    @server.tool(
        name="search_services",
        description=(
            "搜索日志中心服务，返回 authorized_found / unauthorized_found / not_found "
            "三级结果（含权限自检）。serviceId 通过本工具动态发现，无需业务线预配置。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def search_services(
        keyword: Annotated[
            str, Field(min_length=1, description="服务名 / topic / username / uid 模糊匹配")
        ],
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("search_services")
        client = client_factory(normalize_env(env))
        try:
            authorized = await client.search_services(keyword)
            if authorized["list"]:
                return {
                    "source": "logcenter",
                    "result_type": "authorized_found",
                    "services": _normalize_services(authorized["list"]),
                }
            unauthorized = await client.check_unauthorized(keyword)
            if unauthorized["list"]:
                return {
                    "source": "logcenter",
                    "result_type": "unauthorized_found",
                    "services": _normalize_services(unauthorized["list"]),
                }
            return {"source": "logcenter", "result_type": "not_found", "services": []}
        except UpstreamError as exc:
            raise _upstream_error(exc) from exc

    @server.tool(
        name="list_services",
        description="分页列出日志中心服务，按权限类型筛选。",
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def list_services(
        permission: Annotated[
            str, Field(description="authorized（默认）/ unauthorized")
        ] = "authorized",
        page: Annotated[int, Field(ge=1, description="页码，从 1 起")] = 1,
        size: Annotated[int, Field(ge=1, le=100, description="每页条数，上限 100")] = 20,
        keyword: Annotated[str | None, Field(description="可选过滤")] = None,
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("list_services")
        client = client_factory(normalize_env(env))
        try:
            data = await client.list_services(
                query=keyword,
                permission=permission,
                page=page,
                size=size,
            )
        except UpstreamError as exc:
            raise _upstream_error(exc) from exc
        return {
            "source": "logcenter",
            "permission": permission,
            "page": data["page"],
            "size": data["size"],
            "total": data["total"],
            "total_page": data["total_page"],
            "count": len(data["list"]),
            "services": _normalize_services(data["list"]),
        }

    @server.tool(
        name="get_fields",
        description="获取服务可查询索引字段（index=true），供构造 Lucene 或 DSL。",
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def get_fields(
        serviceId: Annotated[
            int, Field(ge=1, description="由 search_services / list_services 返回")
        ],
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("get_fields")
        client = client_factory(normalize_env(env))
        try:
            return {"source": "logcenter", **await client.get_fields(serviceId)}
        except UpstreamError as exc:
            raise _upstream_error(exc, service_id=serviceId) from exc

    @server.tool(
        name="get_storage_type",
        description="获取服务存储类型及稳定别名（es/tls/cls/bls），决定查询语法路由。",
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def get_storage_type(
        serviceId: Annotated[int, Field(ge=1)],
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("get_storage_type")
        client = client_factory(normalize_env(env))
        try:
            return {"source": "logcenter", **await client.get_storage_type(serviceId)}
        except UpstreamError as exc:
            raise _upstream_error(exc, service_id=serviceId) from exc

    @server.tool(
        name="count",
        description="统计日志总数（不返回内容）。支持 query 过滤。",
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def count(
        serviceId: Annotated[int, Field(ge=1)],
        time: Annotated[str, Field(description=TIME_PARAM_DESCRIPTION)] = "15m",
        query: Annotated[str, Field(description="Lucene")] = "*",
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("count")
        start, end = _resolve_range(time)
        client = client_factory(normalize_env(env))
        try:
            total = await client.count(serviceId, start, end, "" if query == "*" else query)
        except UpstreamError as exc:
            raise _upstream_error(exc, service_id=serviceId) from exc
        return {
            "source": "logcenter",
            "service_id": serviceId,
            "time": time,
            "start": start,
            "end": end,
            "total": total,
        }

    @server.tool(
        name="query",
        description=(
            "检索日志内容（Lucene 语法）。page 从 1 起（页码），每页 40 条；时间用秒。"
            "full=false 返回精简字段，full=true 返回全字段；两者均过脱敏。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def query(
        serviceId: Annotated[int, Field(ge=1)],
        time: Annotated[str, Field(description=TIME_PARAM_DESCRIPTION)] = "15m",
        query: Annotated[str, Field(description="Lucene")] = "*",
        page: Annotated[int, Field(ge=1, description="页码（非偏移）")] = 1,
        full: Annotated[bool, Field(description="是否返回全字段（仍过脱敏）")] = False,
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("query")
        start, end = _resolve_range(time)
        client = client_factory(normalize_env(env))
        try:
            result = await client.search(
                serviceId, start, end, "" if query == "*" else query, page, 40
            )
        except UpstreamError as exc:
            raise _upstream_error(exc, service_id=serviceId) from exc
        logs = result["logs"]
        rows = logs if full else [_compact_log(log) for log in logs]
        # full=true 按工具契约返回全字段：不做逐字段截断，只保留总预算护栏。
        rows, budget_meta = apply_budget_to_log_rows(rows, clip=not full)
        payload = {
            "source": "logcenter",
            "service_id": serviceId,
            "time": time,
            "start": start,
            "end": end,
            "total": result["total"],
            "page": page,
            "count": len(rows),
            "logs": redact(rows),
        }
        payload.update(budget_meta)
        return payload

    @server.tool(
        name="dsl_search",
        description=(
            "透传 ES Query Body。@timestamp 用毫秒；禁 script / script_fields；"
            "from + size <= 10000。返回的 _source 过脱敏（始终全字段，无 full 参数）。"
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def dsl_search(
        serviceId: Annotated[int, Field(ge=1)],
        dsl: Annotated[dict[str, Any], Field(description="ES Query Body")],
        size: Annotated[int | None, Field(ge=0, le=200, description="与 from 之和 ≤ 10000")] = None,
        from_: Annotated[int | None, Field(ge=0, description="偏移量（DSL 语义）")] = None,
        env: Annotated[
            str, Field(description="日志中心环境 prod/test；缺省=启动 LOG_MCP_ENV")
        ] = boot_env,
    ) -> dict[str, Any]:
        require_scope("dsl_search")
        resolved_size, resolved_from = _validate_dsl(dsl, size, from_)
        client = client_factory(normalize_env(env))
        try:
            data = await client.dsl_search(serviceId, dsl, resolved_size, resolved_from)
        except UpstreamError as exc:
            raise _upstream_error(exc, service_id=serviceId) from exc
        hits = [
            {
                "_index": h.get("_index"),
                "_id": h.get("_id"),
                "sort": h.get("sort"),
                "_source": redact(h.get("_source") or {}),
            }
            for h in data["hits"]["hits"]
        ]
        return {
            "source": "logcenter",
            "service_id": serviceId,
            "total": data["hits"]["total"],
            "took": data.get("took"),
            "count": len(hits),
            "aggregations": data.get("aggregations"),
            "hits": hits,
        }


def _normalize_services(services: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """标准化服务列表输出。"""
    normalized = []
    for svc in services:
        normalized.append(
            {
                "id": svc.get("id"),
                "name": svc.get("name"),
                "topic": svc.get("topic"),
                "username": svc.get("username"),
                "uid": svc.get("uid"),
                "log_type": svc.get("log_type"),
                "status": svc.get("status"),
            }
        )
    return normalized
