from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastmcp import FastMCP
from fastmcp.tools.base import ToolResult
from mcp.types import TextContent
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelRetry, ToolFailed
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from harmony_agent.toolsets.failure_budget import BudgetedToolset, ToolFailureBudget


async def test_failed_signature_is_canonical_and_other_parameters_can_recover() -> None:
    budget = ToolFailureBudget()
    broken = AsyncMock(side_effect=OSError("missing"))
    events = []
    with pytest.raises(ToolFailed, match="OSError"):
        await budget.call("read", {"path": "missing", "line": 1}, broken, events)
    with pytest.raises(ToolFailed, match="禁止原样重试"):
        await budget.call("read", {"line": 1, "path": "missing"}, broken, events)
    assert broken.await_count == 1
    good = AsyncMock(return_value="source")
    assert await budget.call("read", {"path": "exists"}, good, events) == "source"
    assert [event.status for event in events] == ["failed", "failed", "completed"]
    assert len(budget.failures) == 2


@pytest.mark.parametrize("message", ["temporary timeout", '{"transient": false}', "retryable"])
async def test_error_prose_never_authorizes_retry(message) -> None:
    budget = ToolFailureBudget()
    call = AsyncMock(side_effect=ModelRetry(message))
    for _ in range(2):
        with pytest.raises(ToolFailed):
            await budget.call("read", {}, call)
    assert call.await_count == 1


async def test_transient_failure_allows_only_one_identical_retry() -> None:
    budget = ToolFailureBudget()
    call = AsyncMock(side_effect=ModelRetry('{"transient": true, "message": "busy"}'))
    for _ in range(3):
        with pytest.raises(ToolFailed):
            await budget.call("read", {}, call)
    assert call.await_count == 2


async def test_transient_retry_can_succeed() -> None:
    budget = ToolFailureBudget()
    call = AsyncMock(side_effect=[ModelRetry('{"transient": true}'), "recovered"])
    with pytest.raises(ToolFailed):
        await budget.call("read", {}, call)
    assert await budget.call("read", {}, call) == "recovered"
    assert len(budget.failures) == 1


async def test_parallel_failures_cannot_overrun_limit_or_repeat_signature() -> None:
    budget = ToolFailureBudget(limit=2)
    call = AsyncMock(side_effect=OSError("unavailable"))
    results = await asyncio.gather(
        *(budget.call("read", {"path": str(index)}, call) for index in range(8)),
        return_exceptions=True,
    )
    assert all(isinstance(result, ToolFailed) for result in results)
    assert call.await_count == 2
    assert len(budget.failures) == 2
    assert budget.exhausted

    fresh = ToolFailureBudget()
    call.reset_mock()
    await asyncio.gather(*(fresh.call("read", {}, call) for _ in range(3)), return_exceptions=True)
    assert call.await_count == 1


async def test_cancellation_propagates_without_spending_budget() -> None:
    budget = ToolFailureBudget()
    call = AsyncMock(side_effect=asyncio.CancelledError())
    with pytest.raises(asyncio.CancelledError):
        await budget.call("read", {}, call)
    assert not budget.failures


async def test_multiple_toolsets_share_budget_and_allow_final_answer() -> None:
    budget = ToolFailureBudget(limit=3)
    first = FunctionToolset()
    second = FunctionToolset()
    executed = []

    @first.tool_plain
    def inspect_file(path: str) -> str:
        executed.append(path)
        raise OSError("injected")

    @second.tool_plain
    def inspect_log(path: str) -> str:
        executed.append(path)
        raise ModelRetry("injected")

    steps = iter(
        [
            ("inspect_file", "one"),
            ("inspect_log", "two"),
            ("inspect_file", "three"),
        ]
    )

    def respond(messages, info):
        step = next(steps, None)
        if step:
            return ModelResponse(parts=[ToolCallPart(step[0], {"path": step[1]})])
        assert info.function_tools == []
        failures = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.outcome == "failed"
        ]
        assert len(failures) == 3
        return ModelResponse(parts=[TextPart("证据不足，请补充日志。")])

    agent = Agent(
        FunctionModel(respond),
        retries=0,
        toolsets=[BudgetedToolset(first, budget), BudgetedToolset(second, budget)],
    )
    result = await agent.run("排查")
    assert result.output == "证据不足，请补充日志。"
    assert executed == ["one", "two", "three"]


async def test_mcp_structured_transient_flag_survives_adapter() -> None:
    server = FastMCP("transient-test")
    attempts = []

    @server.tool
    def read_status() -> ToolResult:
        attempts.append(1)
        payload = {"transient": True, "message": "busy"}
        return ToolResult(
            is_error=True,
            content=[TextContent(type="text", text=json.dumps(payload))],
            structured_content=payload,
        )

    budget = ToolFailureBudget()
    toolset = MCPToolset(server, tool_error_behavior="retry")
    for _ in range(3):
        with pytest.raises(ToolFailed):
            await budget.call(
                "read_status", {}, lambda: toolset.direct_call_tool("read_status", {})
            )
    assert len(attempts) == 2
