from __future__ import annotations

import asyncio
import copy
import json
import os
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastmcp import Client
from fastmcp.client.transports import StdioTransport, StreamableHttpTransport
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.toolsets import FunctionToolset

from .dev_knowledge_validation import identity, validate_response

DEV_KNOWLEDGE_TOOLS = {"resolve_external_knowledge", "read_external_knowledge"}
Operation = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class ProductRoute(BaseModel):
    model_config = ConfigDict(extra="forbid")
    business_line: str = Field(min_length=1)
    product_id: str = Field(min_length=1)
    terms: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)
    # Exact known activity terms constrain topics; generic symptoms never select a product.
    topic_terms: dict[str, list[Annotated[str, Field(min_length=1)]]] = Field(default_factory=dict)


class DevKnowledgeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transport: Literal["stdio", "http"]
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    cwd: str | None = None
    url: str | None = None
    token_env: str | None = None
    timeout_seconds: float = Field(default=30, ge=0.1, le=120)
    max_result_chars: int = Field(default=16000, ge=2000, le=32000)
    products: list[ProductRoute] = Field(min_length=1)
    excluded_terms: list[Annotated[str, Field(min_length=1)]] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_transport(self) -> DevKnowledgeConfig:
        if self.transport == "stdio":
            if not self.command or self.url or self.token_env:
                raise ValueError("stdio requires command and forbids HTTP credentials")
        else:
            parsed = urlsplit(self.url or "")
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("HTTP requires an absolute endpoint")
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("endpoint must not contain credentials, query or fragment")
            if self.command or self.args or self.cwd:
                raise ValueError("HTTP cannot execute a command")
            if (
                self.token_env
                and parsed.scheme != "https"
                and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            ):
                raise ValueError("remote bearer credentials require HTTPS")
        keys = [(p.business_line, p.product_id) for p in self.products]
        if len(set(keys)) != len(keys):
            raise ValueError("duplicate product route")
        return self


def _contains(text: str, terms: list[str]) -> bool:
    return any(term.casefold() in text.casefold() for term in terms)


def _size(value: dict[str, Any]) -> int:
    return len(json.dumps(value, ensure_ascii=False))


def bounded_result(value: dict[str, Any], limit: int) -> dict[str, Any]:
    value = copy.deepcopy(value)
    if _size(value) <= limit:
        return value
    value["truncated"] = True
    value["truncation"] = {
        "reason": "consumer_result_budget",
        "next_action": "Read fewer sections; do not repeat an oversized single section.",
        "upstream": value.get("truncation"),
    }
    if "candidates" in value:
        for candidate in value["candidates"]:
            candidate.pop("snippets", None)
            candidate.pop("summary", None)
    elif value.get("status") == "ok" and "sections" in value:
        omitted = []
        while value["sections"] and _size(value) > limit:
            omitted.append(value["sections"].pop()["section_id"])
            refs = {r for s in value["sections"] for i in s["items"] for r in i["source_ref_keys"]}
            value["source_catalog"] = {
                k: v for k, v in value["source_catalog"].items() if k in refs
            }
            used = {
                v["code_source_id"] for v in value["source_catalog"].values() if v["kind"] == "code"
            }
            value["code_sources"] = {k: v for k, v in value["code_sources"].items() if k in used}
        value["truncation"]["omitted_section_ids"] = omitted
        if not value["sections"]:
            return {
                "status": "response_too_large",
                "key": value["key"],
                "truncated": True,
                "truncation": value["truncation"],
            }
    if _size(value) > limit:
        return {
            "status": "response_too_large",
            "truncated": True,
            "gap_reason": "Metadata exceeds the consumer budget; use another evidence source.",
        }
    return value


class DevKnowledgeAdapter:
    """Per-turn read-only boundary. Only two fixed upstream tools are callable."""

    def __init__(
        self, config: DevKnowledgeConfig, input_texts: list[str], operation: Operation | None = None
    ) -> None:
        self.config = config
        self.input_texts = input_texts
        self.operation = operation or self._mcp_call
        self.resolved: dict[tuple[str, str, str], set[str]] = {}

    async def _mcp_call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        cfg = self.config
        if cfg.transport == "stdio":
            transport = StdioTransport(cfg.command, cfg.args, cwd=cfg.cwd, keep_alive=False)
        else:
            token = os.environ.get(cfg.token_env) if cfg.token_env else None
            if cfg.token_env and not token:
                raise ToolFailed("external_auth_missing: configured credential is unavailable")
            transport = StreamableHttpTransport(cfg.url, auth=token)
        async with Client(transport) as client:
            result = await client.call_tool_mcp(name, arguments, timeout=cfg.timeout_seconds)
        if result.isError:
            raise ToolFailed("external_tool_error: upstream rejected the request")
        if isinstance(result.structuredContent, dict):
            return result.structuredContent
        blocks = [c.text for c in result.content if c.type == "text"]
        if len(blocks) != 1:
            raise ToolFailed("external_contract_error: expected one JSON response")
        return json.loads(blocks[0])

    async def _call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                value = await self.operation(name, arguments)
        except TimeoutError:
            raise ToolFailed("external_timeout: report the gap; no automatic retry") from None
        except ToolFailed:
            raise
        except Exception:
            # Transport errors may include URLs/headers; never return raw exceptions to the model.
            raise ToolFailed("external_transport_error: check service and authentication") from None
        try:
            validate_response(name, arguments, value)
        except Exception:
            raise ToolFailed(
                "external_contract_error: response identity or source contract failed"
            ) from None
        if value["status"] == "invalid_request":
            raise ToolFailed("external_invalid_request: request rejected")
        return value

    async def resolve(self, query: str, product_id: str | None = None) -> dict[str, Any]:
        query = query.strip()
        if not query or len(query) > 400 or not any(query in text for text in self.input_texts):
            raise ToolFailed("Use a short verbatim symptom from user input, not an invented query.")
        # Do not export likely secrets or full log records as search terms.
        if re.search(
            r"(?i)bearer\s|password\s*[:=]|token\s*[:=]|secret\s*[:=]|\b1[3-9]\d{9}\b", query
        ):
            raise ToolFailed("Select a symptom without credentials or personal identifiers.")
        if _contains(query, self.config.excluded_terms):
            return {"status": "not_covered", "gap_reason": "Use local knowledge and evidence."}
        routes = [p for p in self.config.products if _contains(query, [p.product_id, *p.terms])]
        if not routes:
            # Only the latest explicit product statement supplies conversational scope.
            for text in reversed(self.input_texts):
                if _contains(text, self.config.excluded_terms):
                    break
                routes = [
                    p for p in self.config.products if _contains(text, [p.product_id, *p.terms])
                ]
                if routes:
                    break
        if len(routes) != 1 or (product_id and routes[0].product_id != product_id):
            return {
                "status": "needs_clarification",
                "gap_reason": "Confirm product and entry route.",
            }
        route = routes[0]
        # Normalize aliases to the canonical term; prepend product vocabulary only when
        # the user's words lack it entirely (duplicating it degrades upstream matching).
        rewritten = query
        for term in route.terms[1:]:
            rewritten = rewritten.replace(term, route.terms[0])
        if route.terms[0].casefold() not in rewritten.casefold():
            rewritten = f"{route.terms[0]} {rewritten}"
        args = {
            "query": rewritten,
            "business_line": route.business_line,
            "product_id": route.product_id,
            "limit": 3,
        }
        value = await self._call("wiki_resolve", args)
        expected_topics = {
            topic for topic, terms in route.topic_terms.items() if _contains(query, [topic, *terms])
        }
        conflict = (
            value["status"] in {"resolved", "ambiguous"}
            and expected_topics
            and not any(c["topic_id"] in expected_topics for c in value["candidates"])
        )
        # Hard conflict: nothing returned matches the locally known activity. Partial
        # ambiguity passes through (it registers no topic, so no read can follow).
        if conflict:
            raise ToolFailed("external_topic_mismatch: candidate conflicts with the known activity")
        value = bounded_result(value, self.config.max_result_chars)
        if value["status"] == "resolved":
            candidate = value["candidates"][0]
            self.resolved[identity(candidate)] = {
                s["section_id"] for s in candidate["recommended_sections"]
            }
        return {
            "source": "dev-knowledge",
            "original_query": query,
            "usage": "Topic leads only. Verify semantic fit before reading; not incident evidence.",
            "result": value,
        }

    async def read(
        self, business_line: str, product_id: str, topic_id: str, section_ids: list[str]
    ) -> dict[str, Any]:
        key = (business_line, product_id, topic_id)
        allowed = self.resolved.get(key, set())
        if not 1 <= len(section_ids) <= 3 or not set(section_ids) <= allowed:
            raise ToolFailed("Read 1-3 recommended sections of a resolved topic from this turn.")
        if len(set(section_ids)) != len(section_ids):
            raise ToolFailed("Duplicate section IDs are not allowed.")
        args = {
            "business_line": business_line,
            "product_id": product_id,
            "topic_id": topic_id,
            "section_ids": section_ids,
        }
        value = await self._call("wiki_read", args)
        return {
            "source": "dev-knowledge",
            "usage": "Static knowledge, not observed incident evidence.",
            "result": bounded_result(value, self.config.max_result_chars),
        }


def build_dev_knowledge_toolset(
    config_path: Path | None, input_texts: list[str]
) -> FunctionToolset | None:
    if config_path is None:
        return None
    adapter: DevKnowledgeAdapter | None = None

    def get_adapter() -> DevKnowledgeAdapter:
        nonlocal adapter
        if adapter is None:
            try:
                config = DevKnowledgeConfig.model_validate_json(config_path.read_text())
            except Exception:
                raise ToolFailed(
                    "external_configuration_error: check the configured JSON file"
                ) from None
            adapter = DevKnowledgeAdapter(config, input_texts)
        return adapter

    toolset = FunctionToolset()

    @toolset.tool_plain
    async def resolve_external_knowledge(
        query: Annotated[str, Field(min_length=1, max_length=400)], product_id: str | None = None
    ) -> dict[str, Any]:
        """Locate external knowledge using a short verbatim user symptom and known product.

        Coverage and terminology are configured, never guessed. Unknown scope returns a question
        without external calls. Check returned topic semantics before read_external_knowledge.
        """
        return await get_adapter().resolve(query, product_id)

    @toolset.tool_plain
    async def read_external_knowledge(
        business_line: str,
        product_id: str,
        topic_id: str,
        section_ids: Annotated[list[str], Field(min_length=1, max_length=3)],
    ) -> dict[str, Any]:
        """Read 1-3 recommended sections of this turn's resolved topic after checking semantic fit.

        Returns static knowledge and source locators, never current incident evidence.
        Check support, gaps and truncation. Verify actual code/logs before a positive diagnosis.
        """
        return await get_adapter().read(business_line, product_id, topic_id, section_ids)

    return toolset
