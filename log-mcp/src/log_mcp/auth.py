"""Bearer 鉴权 ASGI 包装器。

校验 OAuth access_token，通过后写入请求级 contextvar（client_id / scope）。
`/oauth/token`、`/oauth/revoke`、`/health` 不走本包装器。

设计见方案 5.9。沿用 dev-agent `BearerAuthDispatcher` 的 ASGI 包装思路，
但凭据来源是 OAuth client_credentials 签发的短期令牌（哈希存储）。
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from log_mcp.auth_context import CLIENT_ID, CLIENT_SCOPE
from log_mcp.token_store import TokenStore


class BearerAuthDispatcher:
    """校验 OAuth access_token，通过后注入 client_id / scope。"""

    def __init__(
        self,
        *,
        app: ASGIApp,
        token_store: TokenStore,
        auth_disabled: bool = False,
    ) -> None:
        self.app = app
        self.token_store = token_store
        self.auth_disabled = auth_disabled

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        if self.auth_disabled:
            # 仅本地回环生效（启动时由 server 校验 host）；放行并注入占位
            cid_token = CLIENT_ID.set("local")
            cscope_token = CLIENT_SCOPE.set("logs:read")
            try:
                await self.app(scope, receive, send)
            finally:
                CLIENT_ID.reset(cid_token)
                CLIENT_SCOPE.reset(cscope_token)
            return

        header = Headers(scope=scope).get("authorization")
        verified = self.token_store.verify_access_token(header)
        if verified is None:
            response = JSONResponse(
                {"error": "invalid_token"},
                status_code=401,
                headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
            )
            await response(scope, receive, send)
            return
        client_id, client_scope = verified
        cid_token = CLIENT_ID.set(client_id)
        cscope_token = CLIENT_SCOPE.set(client_scope)
        try:
            await self.app(scope, receive, send)
        finally:
            CLIENT_ID.reset(cid_token)
            CLIENT_SCOPE.reset(cscope_token)
