"""日志中心客户端：7 个方法对应 7 个工具。

移植自 `dev-agent-logs/src/appx/log.mjs::LogCenterClient`，改写为 httpx.AsyncClient。
网关：`/skill/service/*`、`/skill/search/*`、`/skill/dsl/*`。
返回结构：列表走 `data.data[]` + `total`。
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from log_mcp.clients.sign import auth_headers

DEFAULT_BASE_URL = "https://logcenter-api.tal.com/api"


class UpstreamError(Exception):
    """上游非 2xx 或 code !== 0；携带 status 与原始消息。"""

    def __init__(self, message: str, *, status: int | None = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class LogCenterClient:
    """日志中心 Skill 网关异步客户端。"""

    def __init__(
        self,
        *,
        cred: Any,
        base_url: str = DEFAULT_BASE_URL,
        timeout_ms: int = 30000,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.cred = cred
        self.base_url = base_url.rstrip("/")
        self.timeout = httpx.Timeout(timeout_ms / 1000, connect=10.0)
        self._transport = transport

    async def request(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """统一请求：签名 + JSON；code !== 0 抛 UpstreamError。"""
        headers = auth_headers(self.cred)
        async with httpx.AsyncClient(timeout=self.timeout, transport=self._transport) as client:
            resp = await client.get(f"{self.base_url}{path}", headers=headers, params=params)
        text = resp.text
        try:
            body: Any = json.loads(text) if text else {}
        except json.JSONDecodeError as exc:
            raise UpstreamError(
                f"日志中心响应非 JSON (status={resp.status_code})",
                status=resp.status_code,
                body=text[:200],
            ) from exc
        if resp.status_code >= 400:
            raise UpstreamError(
                f"日志中心 HTTP {resp.status_code}",
                status=resp.status_code,
                body=body,
            )
        if isinstance(body, dict) and body.get("code") not in (None, 0):
            raise UpstreamError(
                str(body.get("msg") or f"日志中心错误 code={body.get('code')}"),
                status=resp.status_code,
                body=body,
            )
        return body if isinstance(body, dict) else {"data": body}

    async def list_services(
        self,
        *,
        query: str | None = None,
        permission: str = "authorized",
        page: int = 1,
        size: int = 20,
    ) -> dict[str, Any]:
        """分页获取日志服务列表（按权限类型）。"""
        params: dict[str, Any] = {"permission_type": permission, "page": page, "size": size}
        if query:
            params["query"] = query
        body = await self.request("/skill/service/list/v2", params)
        data = body.get("data") or {}
        return {
            "list": data.get("list") or [],
            "total": data.get("total") or 0,
            "total_page": data.get("total_page") or 0,
            "page": data.get("page") or page,
            "size": data.get("size") or size,
        }

    async def search_services(self, keyword: str) -> dict[str, Any]:
        """搜索有权限的服务。"""
        data = await self.list_services(query=keyword, permission="authorized", page=1, size=100)
        return {"list": data["list"], "total": data["total"]}

    async def check_unauthorized(self, keyword: str) -> dict[str, Any]:
        """检查无权限服务。"""
        data = await self.list_services(query=keyword, permission="unauthorized", page=1, size=100)
        return {"list": data["list"], "total": data["total"]}

    async def get_storage_type(self, service_id: int) -> dict[str, Any]:
        """获取服务存储类型及稳定别名。"""
        body = await self.request("/skill/service/storage-type", {"service_id": service_id})
        data = body.get("data") or {}
        alias = (data.get("alias") or "").lower()
        return {
            "service_id": service_id,
            "storage_type": data.get("storage_type"),
            "alias": alias,
            "is_cloud_storage": alias in {"cls", "bls"},
        }

    async def get_fields(self, service_id: int) -> dict[str, Any]:
        """获取服务可查询索引字段（index=true）。

        日志中心无独立 fields 接口，通过 list 服务接口带出 mappings 后过滤。
        """
        data = await self.list_services(
            query=str(service_id), permission="authorized", page=1, size=100
        )
        svc = next((s for s in data["list"] if s.get("id") == service_id), None)
        if svc is None:
            return {"service_id": service_id, "found": False, "fields": []}
        fields = [
            {"name": f.get("name"), "type": f.get("type"), "index": f.get("index") is not False}
            for f in (svc.get("mappings") or [])
            if f.get("index") is not False
        ]
        return {
            "service_id": service_id,
            "found": True,
            "field_count": len(fields),
            "fields": fields,
        }

    async def count(self, service_id: int, start: int, end: int, query: str = "") -> int:
        """统计日志总数（不返回内容）。时间戳用秒。"""
        params = {
            "type": 2,
            "service_id": service_id,
            "start": start,
            "end": end,
            "from": 1,
            "size": 40,
            "tag_from": 2,
            "query_interval": "auto",
            "retrieval_type": 2,
        }
        if query:
            params["fuzzy_query"] = query
        body = await self.request("/skill/search/time", params)
        return int(body.get("total") or 0)

    async def search(
        self,
        service_id: int,
        start: int,
        end: int,
        query: str = "",
        page: int = 1,
        size: int = 40,
    ) -> dict[str, Any]:
        """检索日志内容（Lucene）。from 为页码（1 起），时间戳用秒。"""
        params = {
            "type": 2,
            "service_id": service_id,
            "start": start,
            "end": end,
            "from": page,
            "size": size,
            "tag_from": 2,
            "query_interval": "auto",
            "retrieval_type": 2,
        }
        if query:
            params["fuzzy_query"] = query
        body = await self.request("/skill/search", params)
        data = body.get("data") or {}
        return {"logs": data.get("data") or [], "total": int(body.get("total") or 0)}

    async def dsl_search(
        self,
        service_id: int,
        dsl: dict[str, Any],
        size: int | None = None,
        from_: int | None = None,
    ) -> dict[str, Any]:
        """透传 ES Query Body。DSL 校验由调用方（工具层）完成，本方法只发请求。"""
        params: dict[str, Any] = {
            "service_id": service_id,
            "dsl": json.dumps(dsl, ensure_ascii=False, separators=(",", ":")),
        }
        if size is not None:
            params["size"] = size
        if from_ is not None:
            params["from"] = from_
        body = await self.request("/skill/dsl/search", params)
        return _normalize_dsl_response(body.get("data") or {})


def _normalize_dsl_response(data: dict[str, Any]) -> dict[str, Any]:
    """归一化 DSL 响应为 ES 原生形态：{hits:{total,hits}, took, aggregations}。

    兼容两种返回：ES 原生（hits.hits / hits.total）与 skill 网关（data 数组 + extend.total）。
    """
    es_hits = (data.get("hits") or {}).get("hits") if isinstance(data.get("hits"), dict) else None
    gateway_hits = data.get("data") if isinstance(data.get("data"), list) else None
    hits = es_hits if isinstance(es_hits, list) else (gateway_hits or [])

    total: Any = None
    if isinstance(data.get("hits"), dict):
        total = data["hits"].get("total")
    if total is None and isinstance(data.get("extend"), dict):
        total = data["extend"].get("total")
    if total is None:
        total = data.get("total")
    if total is None:
        total = len(hits)

    return {
        "hits": {"total": total, "hits": hits},
        "took": data.get("took"),
        "aggregations": data.get("aggregations"),
    }
