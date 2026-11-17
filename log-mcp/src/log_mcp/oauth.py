"""OAuth 2.1 client_credentials 端点：`/oauth/token` 与 `/oauth/revoke`。

只实现 client_credentials 一个 grant type（服务对服务，无浏览器跳转）。
`/oauth/token` 用 client_id + client_secret 自证换 access_token；
`/oauth/revoke` 用同一对凭据自证吊销令牌（RFC 7009 容错）。
"""

from __future__ import annotations

from typing import Any

from starlette.datastructures import FormData
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from log_mcp.token_store import DEFAULT_TOKEN_TTL_SECONDS, TokenStore

# OAuth 2.1 标准错误码
_INVALID_CLIENT = "invalid_client"
_INVALID_REQUEST = "invalid_request"
_INVALID_GRANT = "invalid_grant"
_UNSUPPORTED_GRANT_TYPE = "unsupported_grant_type"


def _form_field(form: FormData, name: str) -> str | None:
    """表单字段；缺失返回 None。"""
    try:
        return form[name]
    except KeyError:
        return None


async def oauth_token(request: Request) -> JSONResponse:
    """POST /oauth/token：client_credentials 换 access_token。"""
    form = await request.form()
    grant_type = _form_field(form, "grant_type")
    if grant_type != "client_credentials":
        return JSONResponse(
            {"error": _UNSUPPORTED_GRANT_TYPE},
            status_code=400,
        )
    client_id = _form_field(form, "client_id") or ""
    client_secret = _form_field(form, "client_secret") or ""
    store: TokenStore = request.app.state.token_store
    granted = store.verify_client(client_id, client_secret)
    if granted is None:
        return JSONResponse({"error": _INVALID_CLIENT}, status_code=401)
    # 注册时的 scopes 优先；请求 scope 仅做交集校验（这里直接用注册的）
    access_token, expires_in = store.issue_token(
        client_id=client_id,
        scopes=granted,
        ttl_seconds=DEFAULT_TOKEN_TTL_SECONDS,
    )
    return JSONResponse(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "scope": granted,
        }
    )


async def oauth_revoke(request: Request) -> Response:
    """POST /oauth/revoke：用 client_id + client_secret 自证吊销令牌。

    RFC 7009：未知 token 也返回 204，避免探测。
    """
    form = await request.form()
    token = _form_field(form, "token") or ""
    client_id = _form_field(form, "client_id") or ""
    client_secret = _form_field(form, "client_secret") or ""
    store: TokenStore = request.app.state.token_store
    if store.verify_client(client_id, client_secret) is None:
        return JSONResponse({"error": _INVALID_CLIENT}, status_code=401)
    if token:
        store.revoke_token(token, client_id, client_secret)
    return Response(status_code=204)


def error_response(error: str, *, status: int = 400, **extra: Any) -> JSONResponse:
    """OAuth 标准错误响应工具。"""
    payload: dict[str, Any] = {"error": error}
    payload.update(extra)
    return JSONResponse(payload, status_code=status)
