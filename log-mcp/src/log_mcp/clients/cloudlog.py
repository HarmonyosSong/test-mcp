"""云日志客户端：6 个方法对应 6 个工具。

参考 `logcenterskill/scripts/logsearch.py` 的 `*_cloud_*` 方法，改写为 httpx.AsyncClient。
当前仅支持阿里云 SLS；`vendor=tencent` 在工具层报错（见 3.2）。
网关：`/skill/cloud/*`。
返回结构：`data.logs[]` + `data.total` + `progress`。
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from log_mcp.clients.sign import auth_headers

DEFAULT_BASE_URL = "https://logcenter-api.tal.com/api"


class UpstreamError(Exception):
    """上游非 2xx 或 code !== 0。"""

    def __init__(self, message: str, *, status: int | None = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class CloudLogClient:
    """云日志 Skill 网关异步客户端。"""

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
                f"云日志响应非 JSON (status={resp.status_code})",
                status=resp.status_code,
                body=text[:200],
            ) from exc
        if resp.status_code >= 400:
            raise UpstreamError(
                f"云日志 HTTP {resp.status_code}",
                status=resp.status_code,
                body=body,
            )
        if isinstance(body, dict) and body.get("code") not in (None, 0):
            raise UpstreamError(
                str(body.get("msg") or f"云日志错误 code={body.get('code')}"),
                status=resp.status_code,
                body=body,
            )
        return body if isinstance(body, dict) else {"data": body}

    async def accounts(self, vendor: str = "aliyun") -> dict[str, Any]:
        """列出某 vendor 下的云日志账号。"""
        body = await self.request("/skill/cloud/accounts", {"vendor": vendor})
        data = body.get("data") or {}
        return {"accounts": data.get("accounts") or [], "total": data.get("total") or 0}

    async def collections(self, *, account: str, vendor: str = "aliyun") -> dict[str, Any]:
        """列出某账号下的日志集（SLS project）。"""
        body = await self.request(
            "/skill/cloud/collections",
            {"vendor": vendor, "account_ak_id": account},
        )
        data = body.get("data") or {}
        return {"collections": data.get("collections") or [], "total": data.get("total") or 0}

    async def topics(
        self,
        *,
        account: str,
        collection: str | None = None,
        vendor: str = "aliyun",
    ) -> dict[str, Any]:
        """列出某账号下的全部 topic，每条自带 collection / region。"""
        params: dict[str, Any] = {"vendor": vendor, "account_ak_id": account}
        if collection:
            params["collection_id"] = collection
        body = await self.request("/skill/cloud/topics", params)
        data = body.get("data") or {}
        return {"topics": data.get("topics") or [], "total": data.get("total") or 0}

    async def count(
        self,
        *,
        vendor: str,
        region: str,
        account: str,
        collection: str,
        topic: str,
        start: int,
        end: int,
    ) -> int:
        """统计某 topic 日志总量（不支持 query 过滤，见 3.4 ②）。"""
        body = await self.request(
            f"/skill/cloud/{vendor}/count",
            {
                "region": region,
                "account_ak_id": account,
                "collection_id": collection,
                "topic_id": topic,
                "start": start,
                "end": end,
            },
        )
        data = body.get("data") or {}
        return int(data.get("total") or 0)

    async def search(
        self,
        *,
        vendor: str,
        region: str,
        account: str,
        collection: str,
        topic: str,
        start: int,
        end: int,
        query: str = "*",
        size: int = 100,
        from_: int = 0,
        reverse: bool = False,
    ) -> dict[str, Any]:
        """检索云日志内容（SLS 类 SQL）。from 为偏移量（0 起）。"""
        body = await self.request(
            f"/skill/cloud/{vendor}/search",
            {
                "region": region,
                "account_ak_id": account,
                "collection_id": collection,
                "topic_id": topic,
                "start": start,
                "end": end,
                "query": query,
                "size": size,
                "from": from_,
                "reverse": reverse,
            },
        )
        data = body.get("data") or {}
        return {
            "logs": data.get("logs") or [],
            "total": int(data.get("total") or 0),
            "progress": data.get("progress"),
            "elapsed_ms": data.get("elapsed_millisecond"),
        }

    async def probe(
        self,
        *,
        vendor: str,
        region: str,
        account: str,
        collection: str,
    ) -> dict[str, Any]:
        """探测某 collection 在某 region 的可访问性与延迟。"""
        start = time.monotonic()
        try:
            body = await self.request(
                "/skill/cloud/probe",
                {
                    "vendor": vendor,
                    "region": region,
                    "account_ak_id": account,
                    "collection_id": collection,
                },
            )
        except UpstreamError as exc:
            return {
                "accessible": False,
                "vendor": vendor,
                "region": region,
                "account": account,
                "collection": collection,
                "latency_ms": int((time.monotonic() - start) * 1000),
                "topics": [],
                "error": {"code": "upstream", "message": str(exc)},
            }
        data = body.get("data") or {}
        return {
            "accessible": bool(data.get("success", False)),
            "vendor": vendor,
            "region": region,
            "account": account,
            "collection": collection,
            "latency_ms": int((time.monotonic() - start) * 1000),
            "topics": data.get("logstores") or [],
        }
