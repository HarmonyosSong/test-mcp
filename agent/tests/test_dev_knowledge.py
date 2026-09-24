from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastmcp import FastMCP
from pydantic_ai import Agent
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from harmony_agent.agents import Completed, HarmonyChatAgent
from harmony_agent.config import Settings
from harmony_agent.domain import Conversation, trim_messages_state
from harmony_agent.runtimes.evidence import EvidenceLedger
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime.registry import SkillRegistry
from harmony_agent.toolsets.dev_knowledge import (
    DevKnowledgeAdapter,
    DevKnowledgeConfig,
    bounded_result,
    build_dev_knowledge_toolset,
)
from harmony_agent.toolsets.dev_knowledge_validation import CONTRACT_DIR, validate_response
from harmony_agent.toolsets.failure_budget import BudgetedToolset, ToolFailureBudget


def fixture(name):
    return json.loads((CONTRACT_DIR / "examples" / f"{name}.json").read_text())


def configuration(**changes):
    return DevKnowledgeConfig.model_validate(
        {
            "transport": "http",
            "url": "http://127.0.0.1:9999/mcp/knowledge/v1",
            "products": [
                {
                    "business_line": "cloudlearn",
                    "product_id": "demo",
                    "terms": ["Demo", "演示产品"],
                    "topic_terms": {"topic-demo": ["指定活动"]},
                }
            ],
            "excluded_terms": ["口语岛"],
            **changes,
        }
    )


class Upstream:
    def __init__(self):
        self.calls = []
        self.resolve = fixture("wiki-resolve-ok")["response"]
        self.read = fixture("wiki-read-ok")["response"]

    async def __call__(self, name, args):
        self.calls.append((name, args))
        result = copy.deepcopy(self.resolve if name == "wiki_resolve" else self.read)
        if name == "wiki_resolve":
            result["query"] = args["query"]
        else:
            result["sections"] = [
                s for s in result["sections"] if s["section_id"] in args["section_ids"]
            ]
        return result


def test_public_bundle_integrity():
    manifest = json.loads((CONTRACT_DIR / "manifest.json").read_text())
    for path, digest in manifest["files"].items():
        assert hashlib.sha256((CONTRACT_DIR / path).read_bytes()).hexdigest() == digest


@pytest.mark.parametrize(
    "name", ["wiki-resolve-ok", "wiki-resolve-miss", "wiki-read-ok", "wiki-read-miss"]
)
def test_public_examples(name):
    case = fixture(name)
    args = case["arguments"]
    if case["tool"] == "wiki_resolve":
        args.update(product_id="demo", limit=3)
    elif case["response"]["status"] == "ok":
        args["section_ids"] = [s["section_id"] for s in case["response"]["sections"]]
    validate_response(case["tool"], args, case["response"])


@pytest.mark.parametrize(
    "query, product, status",
    [
        ("朗读完没有分数", None, "needs_clarification"),
        ("朗读完没有分数", "demo", "needs_clarification"),
        ("口语岛没有分数", None, "not_covered"),
        ("Demo 登录失败", "invented", "needs_clarification"),
    ],
)
async def test_no_call_without_coverage(query, product, status):
    upstream = Upstream()
    adapter = DevKnowledgeAdapter(configuration(), [query], upstream)
    assert (await adapter.resolve(query, product))["status"] == status
    assert not upstream.calls


async def test_history_scope_rewrite_and_read():
    upstream = Upstream()
    adapter = DevKnowledgeAdapter(configuration(), ["我在演示产品", "登录失败"], upstream)
    result = await adapter.resolve("登录失败")
    assert upstream.calls[0][1]["query"] == "Demo 登录失败"
    assert result["original_query"] == "登录失败"
    read = await adapter.read("cloudlearn", "demo", "topic-demo", ["overview"])
    assert read["result"]["status"] == "ok"
    assert [c[0] for c in upstream.calls] == ["wiki_resolve", "wiki_read"]
    ledger = EvidenceLedger()
    assert ledger.capture("read_external_knowledge", {}, read) == read
    assert not ledger.entries


async def test_latest_product_scope_does_not_reuse_older_scope():
    upstream = Upstream()
    cfg = configuration()
    adapter = DevKnowledgeAdapter(cfg, ["Demo 登录", "现在查口语岛", "没有分数"], upstream)
    assert (await adapter.resolve("没有分数"))["status"] == "needs_clarification"
    assert not upstream.calls


@pytest.mark.parametrize("query", ["invented", "Demo token=abc", "Demo 13812345678"])
async def test_reject_invented_or_sensitive_query(query):
    upstream = Upstream()
    adapter = DevKnowledgeAdapter(configuration(), ["Demo token=abc 13812345678"], upstream)
    with pytest.raises(ToolFailed):
        await adapter.resolve(query)
    assert not upstream.calls


@pytest.mark.parametrize(
    "mutation", ["product", "business", "count", "confidence", "not_found", "topic"]
)
async def test_bad_resolve_rejected(mutation):
    upstream = Upstream()
    response = upstream.resolve
    if mutation == "product":
        response["candidates"][0]["product_id"] = "wrong"
    elif mutation == "business":
        response["candidates"][0]["business_line"] = "wrong"
    elif mutation == "count":
        response["candidates"].append(copy.deepcopy(response["candidates"][0]))
    elif mutation == "confidence":
        response["candidates"][0]["confidence"] = "low"
    elif mutation == "not_found":
        response["status"] = "not_found"
    else:
        response["candidates"][0]["topic_id"] = "wrong"
    adapter = DevKnowledgeAdapter(configuration(), ["Demo 指定活动"], upstream)
    with pytest.raises(ToolFailed, match="external_(contract_error|topic_mismatch)"):
        await adapter.resolve("Demo 指定活动")
    assert not adapter.resolved


def ambiguous_response(*topic_ids):
    response = fixture("wiki-resolve-ok")["response"]
    response["status"] = "ambiguous"
    response["resolution"] = {
        "credible_candidate_count": 0,
        "confidence": "low",
        "next_action": "Narrow the query with the user; no topic is registered.",
    }
    base = response["candidates"][0]
    response["candidates"] = []
    for topic_id in topic_ids:
        candidate = copy.deepcopy(base)
        candidate["topic_id"] = topic_id
        candidate["confidence"] = "low"
        response["candidates"].append(candidate)
    return response


async def test_partial_ambiguity_passes_without_registering_a_topic():
    upstream = Upstream()
    upstream.resolve = ambiguous_response("topic-demo", "topic-other")
    adapter = DevKnowledgeAdapter(configuration(), ["Demo 指定活动"], upstream)
    result = await adapter.resolve("Demo 指定活动")
    assert result["result"]["status"] == "ambiguous"
    assert not adapter.resolved
    with pytest.raises(ToolFailed, match="resolved topic"):
        await adapter.read("cloudlearn", "demo", "topic-demo", ["overview"])


async def test_ambiguity_without_any_known_match_is_rejected():
    upstream = Upstream()
    upstream.resolve = ambiguous_response("topic-other")
    adapter = DevKnowledgeAdapter(configuration(), ["Demo 指定活动"], upstream)
    with pytest.raises(ToolFailed, match="external_topic_mismatch"):
        await adapter.resolve("Demo 指定活动")
    assert not adapter.resolved


async def test_echo_and_timeout_errors_are_sanitized():
    async def wrong_echo(name, args):
        return fixture("wiki-resolve-ok")["response"]

    adapter = DevKnowledgeAdapter(configuration(), ["Demo 登录"], wrong_echo)
    with pytest.raises(ToolFailed, match="contract_error"):
        await adapter.resolve("Demo 登录")

    async def slow(name, args):
        await asyncio.sleep(1)

    adapter = DevKnowledgeAdapter(configuration(timeout_seconds=0.1), ["Demo 登录"], slow)
    with pytest.raises(ToolFailed, match="external_timeout"):
        await adapter.resolve("Demo 登录")

    async def secret_error(name, args):
        raise RuntimeError("secret=do-not-expose")

    adapter.operation = secret_error
    with pytest.raises(ToolFailed, match="external_transport_error") as error:
        await adapter.resolve("Demo 登录")
    assert "do-not-expose" not in str(error.value)


@pytest.mark.parametrize("mutation", ["topic", "source", "path", "section", "service", "revision"])
async def test_read_identity_and_source_closure(mutation):
    upstream = Upstream()
    response = upstream.read
    code = next(v for v in response["source_catalog"].values() if v["kind"] == "code")
    if mutation == "topic":
        response["topic"]["topic_id"] = "other"
    elif mutation == "source":
        response["source_catalog"] = {}
    elif mutation == "path":
        code["relative_path"] = "../secrets"
    elif mutation == "section":
        response["sections"][0]["section_id"] = "not-requested"
    elif mutation == "service":
        code["service_ids"] = ["invented-service"]
    else:
        response["code_sources"][code["code_source_id"]]["revision"]["head_commit"] = "bad"
    adapter = DevKnowledgeAdapter(configuration(), ["Demo 登录"], upstream)
    await adapter.resolve("Demo 登录")
    with pytest.raises(ToolFailed, match="contract_error"):
        await adapter.read("cloudlearn", "demo", "topic-demo", ["overview"])


async def test_read_requires_resolve_and_recommended_sections():
    upstream = Upstream()
    adapter = DevKnowledgeAdapter(configuration(), ["Demo 登录"], upstream)
    with pytest.raises(ToolFailed):
        await adapter.read("cloudlearn", "demo", "topic-demo", ["overview"])
    await adapter.resolve("Demo 登录")
    for ids in [[], ["other"], ["overview", "overview"]]:
        with pytest.raises(ToolFailed):
            await adapter.read("cloudlearn", "demo", "topic-demo", ids)
    assert len(upstream.calls) == 1


def test_bounded_read_keeps_reference_closure_and_history():
    response = fixture("wiki-read-ok")["response"]
    extra = copy.deepcopy(response["sections"][0])
    extra["section_id"] = "huge"
    extra["items"][0]["text"] = "x" * 25000
    response["sections"].append(extra)
    result = bounded_result(response, 16000)
    assert result["truncated"]
    assert result["truncation"]["omitted_section_ids"] == ["huge"]
    args = {**result["key"], "section_ids": ["overview", "huge"]}
    # Adapter truncation has a consumer-specific shape; upstream closure remains intact.
    upstream_shape = copy.deepcopy(result)
    upstream_shape["truncation"] = {"reason": "budget", "next_action": "read"}
    validate_response("wiki_read", args, upstream_shape)
    assert len(json.dumps(result, ensure_ascii=False)) < 16000
    state = [
        {
            "kind": "request",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "read_external_knowledge",
                    "content": result,
                }
            ],
        }
    ]
    assert trim_messages_state(state, tool_return_max_chars=100) == state
    assert bounded_result(response, 2000)["status"] == "response_too_large"


async def test_missing_config_is_a_tool_failure_and_absent_config_disables(tmp_path):
    assert build_dev_knowledge_toolset(None, []) is None
    tools = build_dev_knowledge_toolset(tmp_path / "missing.json", ["Demo 登录"])
    budget = ToolFailureBudget()
    calls = 0

    def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(
                parts=[ToolCallPart("resolve_external_knowledge", {"query": "Demo 登录"})]
            )
        return ModelResponse(parts=[TextPart("配置缺口")])

    result = await Agent(FunctionModel(respond), toolsets=[BudgetedToolset(tools, budget)]).run(
        "查"
    )
    assert result.output == "配置缺口"
    assert len(budget.failures) == 1
    assert "configuration_error" in budget.failures[0]


async def test_no_progress_and_reuse_share_budget():
    budget = ToolFailureBudget(no_progress_limit=2)
    upstream = AsyncMock(return_value={"result": {"status": "not_found"}})
    await budget.call("resolve_external_knowledge", {"query": "a"}, upstream)
    await budget.call("resolve_external_knowledge", {"query": "a"}, upstream)
    assert budget.executed == 1 and budget.reused == 1 and budget.exhausted
    upstream.assert_awaited_once()


async def test_chat_agent_mounts_adapter_and_counts_calls(tmp_path, monkeypatch):
    upstream = Upstream()
    monkeypatch.setattr(
        DevKnowledgeAdapter, "_mcp_call", lambda self, name, args: upstream(name, args)
    )
    path = tmp_path / "external.json"
    path.write_text(configuration().model_dump_json())
    root = Path(__file__).resolve().parents[2]
    registry = SkillRegistry(root / "skills")
    registry.load()
    gateway = ModelGateway(
        Settings(
            _env_file=None,
            dev_knowledge_config=path,
            knowledge_root=root / "knowledge",
            knowledge_query_log="off",
            model_config_file=tmp_path / "model.json",
        )
    )
    calls = 0

    def next_response(info):
        nonlocal calls
        calls += 1
        assert "resolve_external_knowledge" in {t.name for t in info.function_tools}
        if calls == 1:
            return "resolve_external_knowledge", {"query": "Demo 登录"}
        if calls == 2:
            return "read_external_knowledge", {
                "business_line": "cloudlearn",
                "product_id": "demo",
                "topic_id": "topic-demo",
                "section_ids": ["overview"],
            }
        return None, None

    async def respond(messages, info):
        name, args = next_response(info)
        if name:
            yield {0: DeltaToolCall(name=name, json_args=json.dumps(args))}
        else:
            yield "缺少现场证据"

    agent = HarmonyChatAgent(registry, gateway)
    agent.model_override = FunctionModel(stream_function=respond)
    events = [event async for event in agent.stream_turn(Conversation(), "Demo 登录")]
    assert isinstance(events[-1], Completed)
    assert events[-1].tool_usage["executed"] == 2
    assert [name for name, _ in upstream.calls] == ["wiki_resolve", "wiki_read"]


async def test_real_mcp_serialization_with_inprocess_server(monkeypatch):
    # Exercise the actual Client call path, without requiring an external service in unit tests.
    import harmony_agent.toolsets.dev_knowledge as module

    server = FastMCP("external-contract-test")
    upstream = Upstream()

    @server.tool
    async def wiki_resolve(query: str, business_line: str, product_id: str, limit: int):
        return await upstream(
            "wiki_resolve",
            {
                "query": query,
                "business_line": business_line,
                "product_id": product_id,
                "limit": limit,
            },
        )

    monkeypatch.setattr(module, "StreamableHttpTransport", lambda *a, **kw: server)
    adapter = DevKnowledgeAdapter(configuration(), ["Demo 登录"])
    assert (await adapter.resolve("Demo 登录"))["result"]["status"] == "resolved"


@pytest.mark.skipif(
    not os.getenv("HARMONY_AGENT_EXTERNAL_SMOKE_CONFIG"), reason="external MCP opt-in"
)
async def test_external_stdio_smoke():
    path = Path(os.environ["HARMONY_AGENT_EXTERNAL_SMOKE_CONFIG"])
    cfg = DevKnowledgeConfig.model_validate_json(path.read_text())
    adapter = DevKnowledgeAdapter(cfg, ["人文阅读口才表达"])
    result = await adapter.resolve("人文阅读口才表达")
    assert result["result"]["status"] == "resolved", result
    topic = result["result"]["candidates"][0]
    read = await adapter.read(
        topic["business_line"],
        topic["product_id"],
        topic["topic_id"],
        [topic["recommended_sections"][0]["section_id"]],
    )
    assert read["result"]["status"] == "ok", read
