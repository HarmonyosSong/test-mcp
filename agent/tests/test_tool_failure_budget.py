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


async def test_search_result_set_without_new_paths_counts_no_progress() -> None:
    """换词搜索若返回的还是同一批文件,计入 no_progress——有结果不等于有进展。
    (实测 wrongBook/cuotiben 式换词绕圈;只认空结果与重复指纹的旧判定抓不到。)"""

    async def _hits(*rows: tuple[str, int]) -> list[dict]:
        return [{"path": path, "line": line, "excerpt": "x"} for path, line in rows]

    budget = ToolFailureBudget(call_limit=20, no_progress_limit=2)
    call = lambda query, rows: budget.call(  # noqa: E731
        "search_project_text", {"query": query}, lambda: _hits(*rows)
    )
    await call("onShowFileSelector", (("a.ets", 10), ("b.ets", 20)))
    assert budget.no_progress == 0
    await call("acceptType", (("a.ets", 10), ("b.ets", 20)))  # 换词但同一批文件同一批行
    assert budget.no_progress == 1
    await call("文件选择器", (("b.ets", 20),))  # 还是已知集合的子集
    assert budget.no_progress == 2
    # no_progress 打满不再全停:进入收尾阶段,只放行 submit
    assert budget.finalize_only and budget.stop_reason is None

    budget2 = ToolFailureBudget(call_limit=20, no_progress_limit=2)
    call2 = lambda query, rows: budget2.call(  # noqa: E731
        "search_project_text", {"query": query}, lambda: _hits(*rows)
    )
    await call2("a", (("a.ets", 1),))
    await call2("b", (("a.ets", 1),))
    assert budget2.no_progress == 1
    await call2("c", (("c.ets", 1),))  # 带来新路径 → 重置
    assert budget2.no_progress == 0
    # 同文件不同行号:新信息,不误计(同文件 140 行后新命中 317 行算新观测)
    await call2("d", (("a.ets", 1),))
    assert budget2.no_progress == 1
    await call2("e", (("a.ets", 317),))
    assert budget2.no_progress == 0


async def test_stale_cache_falls_back_to_reread_and_restores_evidence() -> None:
    """复用前核对证据依赖:引用已被淘汰时缓存失效,允许一次真实重读;
    同内容恢复同一内容哈希 ID,计 evidence_restored 且不计无进展。"""
    from harmony_agent.runtimes.evidence import EvidenceLedger

    ledger = EvidenceLedger(max_entries=1)
    budget = ToolFailureBudget(call_limit=20, no_progress_limit=2)
    row = {"path": "a.ets", "start_line": 1, "content": "same line"}

    async def op() -> dict:
        return ledger.capture("read_project_file", {"relative_path": "a.ets"}, row)

    first = await budget.call("read_project_file", {"relative_path": "a.ets"}, op, ledger=ledger)
    old_id = first["evidence_refs"][0]["id"]
    # 模拟跨轮:保护集清空,另一条观测把旧者挤出账本
    ledger._current_turn_ids.clear()
    ledger.capture(
        "read_project_file",
        {"relative_path": "b.ets"},
        {"path": "b.ets", "start_line": 1, "content": "other"},
    )
    assert old_id not in ledger.entries
    again = await budget.call("read_project_file", {"relative_path": "a.ets"}, op, ledger=ledger)
    assert "reused_from_call" not in again
    assert again["evidence_refs"][0]["id"] == old_id
    assert budget.restored == 1
    assert budget.no_progress == 0


async def test_default_arguments_normalize_to_same_signature() -> None:
    """省略默认参数与显式传同值是同一次调用:第二次直接复用,不重复执行。"""
    budget = ToolFailureBudget()
    op = AsyncMock(return_value=[{"path": "a.ets", "line": 1, "excerpt": "x"}])
    await budget.call("search_project_text", {"query": "q"}, op)
    again = await budget.call(
        "search_project_text", {"query": "q", "file_glob": "**/*", "limit": 50}, op
    )
    assert again["reused_from_call"] == 1
    assert op.await_count == 1


async def test_rebinding_same_commit_keeps_cache_but_new_commit_invalidates() -> None:
    """重绑同一 commit 幂等不清缓存;换 commit(或提取不到)才失效。"""
    budget = ToolFailureBudget()
    op = AsyncMock(return_value="source")
    bound = "已绑定仓库 xesapp @ main(commit 6919c027f1d8),只读快照已就绪"
    bind = AsyncMock(return_value=bound)
    await budget.call("bind_repository", {"name_or_url": "xesapp"}, bind)
    await budget.call("read_project_file", {"path": "a.ets"}, op)
    # 同 commit 幂等重绑:缓存保留
    await budget.call("bind_repository", {"name_or_url": "xesapp"}, bind)
    again = await budget.call("read_project_file", {"path": "a.ets"}, op)
    assert "reused_from_call" in again
    assert op.await_count == 1
    # 换 commit:缓存失效,真实重读
    bind2 = AsyncMock(return_value=bound.replace("6919c027f1d8", "abcdef123456"))
    await budget.call("bind_repository", {"name_or_url": "xesapp"}, bind2)
    third = await budget.call("read_project_file", {"path": "a.ets"}, op)
    assert "reused_from_call" not in third
    assert op.await_count == 2


async def test_reused_result_carries_evidence_refs() -> None:
    """复用返回必须带回首次结果的 evidence_refs:只说"请复用已有结果"时模型拿不回
    证据 ID,只能换参数重读来恢复(实测因此烧掉收尾预算并触发停止)。"""
    budget = ToolFailureBudget(call_limit=10)
    refs = [
        {
            "id": "ev-0123456789abcdef",
            "kind": "source",
            "source": "mcp:read_project_file",
            "location": "a.ets:1",
        }
    ]

    async def op() -> dict:
        return {"evidence_refs": refs, "result": {"content": "1: code"}}

    first = await budget.call("read_project_file", {"relative_path": "a.ets"}, op)
    assert first["evidence_refs"] == refs
    again = await budget.call("read_project_file", {"relative_path": "a.ets"}, op)
    assert again["reused_from_call"] == 1
    assert again["evidence_refs"] == refs


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


async def test_low_budget_warning_appended_only_near_exhaustion() -> None:
    """预算将尽时(剩余 ≤ WARN_REMAINING_CALLS)成功结果附 budget_notice,之前不附。"""
    budget = ToolFailureBudget(call_limit=7)
    call = AsyncMock(return_value={"hits": ["x"]})
    # 第 1 次后剩余 6 > 5:无预警
    first = await budget.call("read", {"path": "a"}, call, [])
    assert "budget_notice" not in first
    # 第 2 次后剩余 5:开始预警,dict 结果合并字段
    second = await budget.call("read", {"path": "b"}, call, [])
    assert second["budget_notice"].startswith("工具预算仅剩 5 次")
    assert second["hits"] == ["x"]
    # 第 3 次后剩余 4:非 dict 结果包装
    text_call = AsyncMock(return_value="plain")
    third = await budget.call("read", {"path": "c"}, text_call, [])
    assert third["result"] == "plain"
    assert third["budget_notice"].startswith("工具预算仅剩 4 次")
    # 预警不计入失败,预算状态正常
    assert budget.failures == []
    assert budget.stop_reason is None


async def test_low_budget_warning_reflects_configured_call_limit() -> None:
    budget = ToolFailureBudget(call_limit=3)
    call = AsyncMock(return_value="data")
    result = await budget.call("read", {}, call, [])
    assert result["budget_notice"].startswith("工具预算仅剩 2 次")
