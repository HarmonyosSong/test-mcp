"""MCP 服务装配：14 工具 + 多 path 调试入口 + OAuth + 健康检查。

核心组件：
  - `LogMcpServer(MCPServer)`：重写 call_tool，把 LogMcpToolError / ValidationError / 未捕获异常
    统一转成方案 5.3.1 的 `isError:true + content[0].text=JSON` 结构。
  - `build_server(groups)`：工具注册函数只写一次，按组装配到不同 MCPServer 实例。
  - `create_app(settings)`：Starlette + lifespan + BearerAuthDispatcher。
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import time
from collections.abc import Callable
from typing import Any

import httpx
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError as SdkToolError
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from log_mcp.auth import BearerAuthDispatcher
from log_mcp.clients.cloudlog import CloudLogClient
from log_mcp.clients.logcenter import LogCenterClient
from log_mcp.clients.redact import redact
from log_mcp.config import Settings, load_settings
from log_mcp.errors import LogMcpToolError, internal_error, make_error_result
from log_mcp.logging_setup import setup_logging
from log_mcp.token_store import TokenStore
from log_mcp.tools.aggregate import register_aggregate_tools
from log_mcp.tools.cloudlog import register_cloudlog_tools
from log_mcp.tools.logcenter import register_logcenter_tools

LOGGER = logging.getLogger("log_mcp")
_TOOL_SEQ = itertools.count(1)

# 启动时打印的关键环境变量名（只报是否注入 / 取值，secret 只显示是否已设）
_STARTUP_ENV_KEYS = (
    "LOG_MCP_HOST",
    "LOG_MCP_PORT",
    "LOG_MCP_ENV",
    "LOG_MCP_DATA_ROOT",
    "LOG_MCP_TIMEOUT_MS",
    "LOG_MCP_AUTH_DISABLED",
    "LOG_MCP_PROD_APPID",
    "LOG_MCP_PROD_APPSECRET",
    "LOG_MCP_TEST_APPID",
    "LOG_MCP_TEST_APPSECRET",
    "LOG_MCP_PROD_BASE_URL",
    "LOG_MCP_TEST_BASE_URL",
    "LOG_MCP_LOGCENTER_BASE_URL",
    "LOG_MCP_CLOUDLOG_VENDOR",
    "LOG_MCP_CLOUDLOG_REGION",
    "LOG_MCP_CLOUDLOG_ACCOUNT",
    "LOG_MCP_CLOUDLOG_COLLECTION",
    "HARMONY_AGENT_DATA_ROOT",
)

# 调试 path 与工具组的映射（方案 7.5）
TOOL_GROUPS: dict[str, Callable[[MCPServer, dict[str, Any]], None]] = {
    "logcenter": register_logcenter_tools,
    "cloud": register_cloudlog_tools,
    "aggregate": register_aggregate_tools,
}

# 全部 14 个工具名，用于 check 动作验证
ALL_TOOL_NAMES = frozenset(
    {
        "search_services",
        "list_services",
        "get_fields",
        "get_storage_type",
        "count",
        "query",
        "dsl_search",
        "cloud_accounts",
        "cloud_collections",
        "cloud_topics",
        "cloud_count",
        "cloud_search",
        "cloud_probe",
        "search_both_logs",
    }
)


class LogMcpServer(MCPServer):
    """重写 call_tool，按方案 5.3.1 统一错误返回结构。

    SDK 默认行为：工具抛异常 → `CallToolResult(content=[TextContent(str(exc))], is_error=True)`。
    但 tool_manager 会把异常包成 `ToolError("Error executing tool {name}: {exc}")`，
    导致 text 不是纯 JSON。这里捕获后取 `__cause__` 还原原始错误。
    """

    async def call_tool(self, name: str, arguments: dict[str, Any], context=None):
        seq = next(_TOOL_SEQ)
        began = time.monotonic()
        safe_args = redact(arguments or {})
        LOGGER.info(
            "tool#%s BEGIN %s args=%s",
            seq,
            name,
            json.dumps(safe_args, ensure_ascii=False, default=str),
        )
        try:
            result = await super().call_tool(name, arguments, context)
            elapsed_ms = int((time.monotonic() - began) * 1000)
            is_error = bool(getattr(result, "is_error", False))
            LOGGER.info(
                "tool#%s END %s ok=%s elapsed_ms=%s",
                seq,
                name,
                not is_error,
                elapsed_ms,
            )
            return result
        except SdkToolError as exc:
            elapsed_ms = int((time.monotonic() - began) * 1000)
            cause = exc.__cause__
            if isinstance(cause, LogMcpToolError):
                LOGGER.info(
                    "tool#%s END %s error=%s elapsed_ms=%s",
                    seq,
                    name,
                    cause.code,
                    elapsed_ms,
                )
                return make_error_result(str(cause))
            if isinstance(cause, ValidationError):
                # 参数校验失败 → bad_request
                fields = sorted({".".join(str(p) for p in err["loc"]) for err in cause.errors()})
                err_obj = LogMcpToolError("bad_request", f"参数校验失败: {', '.join(fields)}")
                LOGGER.info(
                    "tool#%s END %s error=bad_request elapsed_ms=%s",
                    seq,
                    name,
                    elapsed_ms,
                )
                return make_error_result(str(err_obj))
            # 未捕获异常 → internal，不泄露细节
            LOGGER.exception("tool#%s END %s crashed elapsed_ms=%s", seq, name, elapsed_ms)
            return make_error_result(str(internal_error()))


class MCPPathDispatcher:
    """把固定 MCP 路径映射到各自的 Streamable HTTP 应用。

    Starlette 的 Mount 对无尾斜杠的精确路径处理与 MCP SDK 期望的 path="/"
    不一致，这里手动重写 scope，与 dev-agent resources-mcp 一致。
    """

    def __init__(self, routes: dict[str, ASGIApp]) -> None:
        self.routes = routes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            response = JSONResponse(
                {"error": {"code": "not_found", "message": "not found"}}, status_code=404
            )
            await response(scope, receive, send)
            return
        path = scope.get("path", "")
        normalized = path[:-1] if path.endswith("/") and path != "/" else path
        app = self.routes.get(normalized)
        if app is None:
            response = JSONResponse(
                {"error": {"code": "not_found", "message": "not found"}}, status_code=404
            )
            await response(scope, receive, send)
            return
        child_scope = dict(scope)
        child_scope["root_path"] = f"{scope.get('root_path', '')}{normalized}"
        child_scope["path"] = "/"
        child_scope["raw_path"] = b"/"
        await app(child_scope, receive, send)


def build_server(groups: list[str], *, deps: dict[str, Any]) -> MCPServer:
    """按组装配 MCPServer；工具注册函数被多实例复用。"""
    server = LogMcpServer(
        name=f"log-mcp-{'-'.join(groups)}",
        instructions="日志查询 MCP：仅负责取日志，不承载业务语义。",
    )
    default_env = deps["default_env"]
    for group in groups:
        if group == "logcenter":
            register_logcenter_tools(
                server,
                client_factory=deps["logcenter_factory"],
                default_env=default_env,
            )
        elif group == "cloud":
            register_cloudlog_tools(
                server,
                client_factory=deps["cloudlog_factory"],
                defaults=deps["cloud_defaults"],
            )
        elif group == "aggregate":
            register_aggregate_tools(
                server,
                logcenter_factory=deps["logcenter_factory"],
                cloudlog_factory=deps["cloudlog_factory"],
                cloud_defaults=deps["cloud_defaults"],
                default_env=default_env,
            )
        else:
            raise ValueError(f"unknown tool group: {group}")
    return server


def _build_factories(settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
    """构造按 env 返回客户端的工厂；transport 可注入用于测试。

    日志中心：工具入参 env → 选该环境的网关 + 凭据。
    云日志：无 env 入参，固定用启动注入的 settings.default_env。
    """
    timeout_ms = settings.timeout_ms
    boot_env = settings.default_env

    def logcenter_factory(env: str) -> LogCenterClient:
        cred = settings.gateway.credential(env)
        return LogCenterClient(
            cred=cred,
            base_url=settings.gateway.base_url(env),
            timeout_ms=timeout_ms,
            transport=transport,
        )

    def cloudlog_factory() -> CloudLogClient:
        # 云日志与日志中心共用 gateway[env]（方案 3.7.2）
        cred = settings.gateway.credential(boot_env)
        return CloudLogClient(
            cred=cred,
            base_url=settings.gateway.base_url(boot_env),
            timeout_ms=timeout_ms,
            transport=transport,
        )

    return logcenter_factory, cloudlog_factory


def create_app(
    settings: Settings | None = None,
    *,
    token_store: TokenStore | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Starlette:
    """装配 ASGI 应用。"""
    resolved = settings or load_settings()
    logcenter_factory, cloudlog_factory = _build_factories(resolved, transport=transport)
    deps = {
        "logcenter_factory": logcenter_factory,
        "cloudlog_factory": cloudlog_factory,
        "cloud_defaults": resolved.cloudlog.defaults,
        "default_env": resolved.default_env,
    }

    # 三个 MCPServer 实例：all / logcenter / cloud（方案 7.5.1）
    servers = {
        "all": build_server(["logcenter", "cloud", "aggregate"], deps=deps),
        "logcenter": build_server(["logcenter"], deps=deps),
        "cloud": build_server(["cloud"], deps=deps),
    }
    apps: dict[str, ASGIApp] = {
        key: srv.streamable_http_app(stateless_http=True, streamable_http_path="/")
        for key, srv in servers.items()
    }

    store = token_store or TokenStore(resolved.data_root_path / "auth.db")
    auth_disabled = _resolve_auth_disabled(resolved)

    def auth_wrap(app: ASGIApp) -> BearerAuthDispatcher:
        return BearerAuthDispatcher(app=app, token_store=store, auth_disabled=auth_disabled)

    # 三个 MCP path → 鉴权包装后的 app（方案 7.5）
    mcp_routes = {
        "/mcp": auth_wrap(apps["all"]),
        "/mcp/logcenter": auth_wrap(apps["logcenter"]),
        "/mcp/cloud": auth_wrap(apps["cloud"]),
    }
    path_dispatcher = MCPPathDispatcher(mcp_routes)

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette):
        """启动三个 MCP session_manager；关闭时吞掉 uvicorn 取消导致的 CancelledError 噪音。"""
        stack = contextlib.AsyncExitStack()
        await stack.__aenter__()
        fatal: BaseException | None = None
        try:
            for srv in servers.values():
                await stack.enter_async_context(srv.session_manager.run())

            async def _close_store() -> None:
                store.close()

            stack.push_async_callback(_close_store)
            yield
        except BaseException as exc:
            # Ctrl+C 会在 yield 处注入 CancelledError；视为正常关机
            if not _is_shutdown_cancel(exc):
                fatal = exc
        try:
            # 主动干净退出，不把 CancelledError 传进 session_manager，减少二次噪音
            await stack.__aexit__(None, None, None)
        except BaseException as exc:
            # MCP session_manager 的 anyio TaskGroup 退出时常抛 ExceptionGroup(CancelledError)
            if not _is_shutdown_cancel(exc) and fatal is None:
                fatal = exc
        if fatal is not None:
            raise fatal
        LOGGER.info("shutdown complete")

    async def health(_request: Request) -> JSONResponse:
        payload: dict[str, Any] = {"status": "ok"}
        if auth_disabled:
            payload["auth"] = "disabled"
        return JSONResponse(payload)

    app = Starlette(
        lifespan=lifespan,
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/mcp", path_dispatcher, methods=["GET", "POST", "DELETE"]),
            Route("/mcp/logcenter", path_dispatcher, methods=["GET", "POST", "DELETE"]),
            Route("/mcp/cloud", path_dispatcher, methods=["GET", "POST", "DELETE"]),
        ],
    )
    app.state.settings = resolved
    app.state.token_store = store
    app.state.mcp_servers = servers
    return app


def _is_shutdown_cancel(exc: BaseException) -> bool:
    """判断是否为进程退出时的取消类异常（含 ExceptionGroup 嵌套）。"""
    if isinstance(exc, asyncio.CancelledError):
        return True
    if isinstance(exc, BaseExceptionGroup):
        return bool(exc.exceptions) and all(_is_shutdown_cancel(item) for item in exc.exceptions)
    return False


def _resolve_auth_disabled(settings: Settings) -> bool:
    """解析鉴权开关；非回环地址强制忽略并报错（方案 7.5.3）。"""
    if not settings.auth.disabled:
        return False
    if settings.host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError(
            "LOG_MCP_AUTH_DISABLED 仅在绑定回环地址（127.0.0.1/localhost/::1）时生效；"
            f"当前 host={settings.host}，开关已强制忽略"
        )
    LOGGER.warning("WARN: 鉴权已关闭，仅限本地开发")
    return True


def _mask_secret(set_: bool) -> str:
    return "<set>" if set_ else "<empty>"


def _log_startup_config(settings: Settings) -> None:
    """打印启动识别到的关键环境变量与解析后的运行配置（secret 脱敏）。"""
    env_lines: list[str] = []
    for key in _STARTUP_ENV_KEYS:
        raw = os.environ.get(key)
        if raw is None:
            env_lines.append(f"  {key}=(unset)")
            continue
        if "SECRET" in key or key.endswith("_TOKEN"):
            env_lines.append(f"  {key}={_mask_secret(bool(raw))}")
        else:
            env_lines.append(f"  {key}={raw}")

    boot = settings.default_env
    prod = settings.gateway.prod
    test = settings.gateway.test
    resolved = {
        "host": settings.host,
        "port": settings.port,
        "env(default)": boot,
        "data_root": str(settings.data_root_path),
        "timeout_ms": settings.timeout_ms,
        "auth.disabled": settings.auth.disabled,
        "gateway.prod.baseUrl": settings.gateway.base_url("prod"),
        "gateway.prod.appid": prod.appid or "<empty>",
        "gateway.prod.appsecret": _mask_secret(bool(prod.appsecret.get_secret_value())),
        "gateway.test.baseUrl": settings.gateway.base_url("test"),
        "gateway.test.appid": test.appid or "<empty>",
        "gateway.test.appsecret": _mask_secret(bool(test.appsecret.get_secret_value())),
        "cloudlog.vendor": settings.cloudlog.vendor,
        "cloudlog.defaults": settings.cloudlog.defaults.model_dump(),
        "tools": sorted(ALL_TOOL_NAMES),
        "mcp_paths": ["/mcp", "/mcp/logcenter", "/mcp/cloud"],
    }
    LOGGER.info("startup env vars (LOG_MCP_*):\n%s", "\n".join(env_lines))
    LOGGER.info(
        "startup resolved settings:\n%s",
        json.dumps(resolved, ensure_ascii=False, indent=2),
    )


def main() -> None:
    """进程入口：读配置、装 app、跑 uvicorn。"""
    settings = load_settings()
    log_file = setup_logging(settings.logs_dir)
    _log_startup_config(settings)
    LOGGER.info("call/runtime logs → %s (按日切换)", log_file)
    app = create_app(settings)
    LOGGER.info(
        "listening http://%s:%s/mcp  (boot env=%s)",
        settings.host,
        settings.port,
        settings.default_env,
    )
    config = uvicorn.Config(
        app,
        host=settings.host,
        port=settings.port,
        log_config=None,
        access_log=False,
        proxy_headers=False,
    )
    server = uvicorn.Server(config)
    try:
        server.run()
    except KeyboardInterrupt:
        # 前台 Ctrl+C：正常退出，不再往外抛栈
        LOGGER.info("interrupted, bye")


if __name__ == "__main__":
    main()
