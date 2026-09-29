"""工具调用指标口径(方案 §8 E)的确定性回归。

口径约定:
- attempted:事件入口(chat 的 FunctionToolCallEvent)计数,模型发起的每个
  工具调用都计入,含将被拒绝的;
- accepted:预算入口计数,兼容旧 calls;
- blocked:预算前拒绝(参数校验失败/工具不可用,事件层归集)+ 预算包装器
  前置拦截(耗尽/收尾);稳定终态(pending=0)满足 attempted = accepted + blocked;
- pending:取消/异常终态仍在途的调用,此时恒等式为
  attempted = accepted + blocked + pending,不硬套终态等式。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from harmony_agent.agents import Completed, HarmonyChatAgent
from harmony_agent.agents.chat import merge_tool_usage
from harmony_agent.config import Settings
from harmony_agent.domain import (
    Conversation,
    DiagnosisReportDraft,
    EvidenceCitation,
    RootCauseCandidate,
)
from harmony_agent.runtimes.evidence import EvidenceLedger
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry
from harmony_agent.toolsets.failure_budget import ToolFailureBudget
from harmony_agent.toolsets.report_submission import SUBMIT_REPORT_TOOL


def _make_agent(tmp_path: Path, monkeypatch, respond, **settings) -> HarmonyChatAgent:
    """搭一个离线聊天 Agent:FunctionModel 脚本化响应,真实工具链全挂。"""
    root = Path(__file__).resolve().parents[2]
    registry = SkillRegistry(root / "skills")
    registry.load()
    gateway = ModelGateway(
        Settings(
            _env_file=None,
            knowledge_root=root / "knowledge",
            model_config_file=tmp_path / "model.json",
            **settings,
        )
    )
    monkeypatch.setattr(
        gateway, "get_model_for", AsyncMock(return_value=FunctionModel(stream_function=respond))
    )
    return HarmonyChatAgent(registry, gateway)


def _read_payload(messages: list) -> dict:
    """从历史消息里找 read_project_file 的真实返回(带 evidence_refs)。"""
    for message in reversed(messages):
        for part in getattr(message, "parts", []):
            if isinstance(part, ToolReturnPart) and part.tool_name == "read_project_file":
                content = part.content
                if isinstance(content, dict) and content.get("evidence_refs"):
                    return content
    raise AssertionError("未找到 read_project_file 的成功返回")


def _observed_draft(payload: dict) -> DiagnosisReportDraft:
    """基于真实读取返回构造合法的正向报告草稿(引用真实证据 ID)。"""
    reference = payload["evidence_refs"][0]
    return DiagnosisReportDraft(
        verdict="probable",
        summary="Throwing branch",
        issue_category="runtime",
        confidence=0.6,
        evidence=[
            EvidenceCitation(
                id=reference["id"],
                excerpt=payload["result"]["content"],
                supports="Throw",
            )
        ],
        root_cause_candidates=[
            RootCauseCandidate(
                title="Throw",
                explanation="Observed source",
                confidence=0.6,
                evidence_ids=[reference["id"]],
            )
        ],
    )


async def test_terminal_equation_holds_with_clean_finalize(tmp_path, monkeypatch) -> None:
    """正常收尾:attempted = accepted + blocked;预算前拒绝(未知工具,
    参数校验/可用性层面)由事件层计入 blocked,不经过预算。"""
    (tmp_path / "a.ets").write_text("throw Error('boom');\n")
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {
                0: DeltaToolCall(name="read_project_file", json_args='{"relative_path": "a.ets"}')
            }
            return
        if calls == 2:
            # 工具表里没有这个名字:pydantic-ai 层直接回 RetryPromptPart,
            # 不会到达预算包装器——这是 blocked 的「预算前拒绝」部分。
            yield {0: DeltaToolCall(name="read_missing_tool", json_args="{}")}
            return
        if calls == 3:
            draft = _observed_draft(_read_payload(messages))
            yield {
                0: DeltaToolCall(
                    name=SUBMIT_REPORT_TOOL,
                    json_args=json.dumps({"draft": draft.model_dump(mode="json")}),
                )
            }
            return
        yield "报告已提交:a.ets 抛出点高度可疑。"

    agent = _make_agent(tmp_path, monkeypatch, respond)
    conversation = Conversation(workspace_path=str(tmp_path))
    events = [event async for event in agent.stream_turn(conversation, "排查 a.ets 的异常")]
    completed = next(event for event in events if isinstance(event, Completed))
    usage = completed.tool_usage

    assert completed.report is not None
    assert usage["schema_version"] == 2
    assert usage["attempted"] == 3
    assert usage["accepted"] == 2
    assert usage["blocked"] == 1
    assert usage["executed"] == 2
    assert usage["pending"] == 0
    assert usage["attempted"] == usage["accepted"] + usage["blocked"]
    assert usage["report_attempts"] == 1
    assert usage["report_validation_failures"] == 0
    # 旧口径兼容:calls/submit_attempts 保留且与 v2 口径同值
    assert usage["calls"] == usage["accepted"]
    assert usage["submit_attempts"] == usage["report_attempts"]
    assert usage["result_chars"] > 0  # 字符量口径保持
    assert usage["model_requests"] == 4


async def test_terminal_equation_holds_when_budget_exhausted(tmp_path, monkeypatch) -> None:
    """预算耗尽:calls 打满 call_limit 后 stop_reason 记录「调用预算已耗尽」,
    此后模型再发的调用(工具表已空)在预算前被拒计 blocked;等式仍成立。

    场景:call_limit=3 = 1 次真实读取 + 2 次校验失败的 submit;
    耗尽后再发 submit 被 pydantic-ai 层拒绝(预算包装器已不再暴露工具)。"""
    (tmp_path / "a.ets").write_text("throw Error('boom');\n")
    calls = 0

    def forged_draft(tag: str) -> DiagnosisReportDraft:
        # 引用从未观测的 ID:真实执行后校验不过(unknown_evidence_id)
        return DiagnosisReportDraft(
            verdict="insufficient_evidence",
            summary=f"伪造引用 {tag}",
            issue_category="runtime",
            confidence=0.3,
            evidence=[EvidenceCitation(id=f"ev-forged-{tag}", excerpt="x", supports="y")],
        )

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {
                0: DeltaToolCall(name="read_project_file", json_args='{"relative_path": "a.ets"}')
            }
            return
        if calls in (2, 3):
            draft = forged_draft(str(calls))
            yield {
                0: DeltaToolCall(
                    name=SUBMIT_REPORT_TOOL,
                    json_args=json.dumps({"draft": draft.model_dump(mode="json")}),
                )
            }
            return
        if calls == 4:
            # 预算已耗尽、工具表为空:该调用在预算前被拒
            draft = forged_draft("late")
            yield {
                0: DeltaToolCall(
                    name=SUBMIT_REPORT_TOOL,
                    json_args=json.dumps({"draft": draft.model_dump(mode="json")}),
                )
            }
            return
        yield "预算已耗尽,如实说明证据缺口。"

    agent = _make_agent(tmp_path, monkeypatch, respond, tool_call_limit=3)
    conversation = Conversation(workspace_path=str(tmp_path))
    events = [event async for event in agent.stream_turn(conversation, "排查 a.ets 的异常")]
    completed = next(event for event in events if isinstance(event, Completed))
    usage = completed.tool_usage

    assert usage["attempted"] == 4
    assert usage["accepted"] == 3
    assert usage["blocked"] == 1
    assert usage["executed"] == 3
    assert usage["pending"] == 0
    assert usage["attempted"] == usage["accepted"] + usage["blocked"]
    assert usage["report_attempts"] == 2
    assert usage["report_validation_failures"] == 2
    assert "调用预算已耗尽" in (usage["stop_reason"] or "")


async def test_finalize_rejection_counts_blocked_once(tmp_path, monkeypatch) -> None:
    """收尾拦截(到达预算但未放行)计 blocked 且只计一次:预算侧已计,
    事件层见到 failed 结果时按「预算曾见过」不再重复归集。"""
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls <= 2:
            # 两次空搜索打满 no_progress → finalize_only
            yield {
                0: DeltaToolCall(
                    name="search_project_text",
                    json_args=json.dumps({"query": f"zzz_nonexistent_{calls}"}),
                )
            }
            return
        if calls == 3:
            # 收尾阶段普通工具被预算拦截(计 blocked,不计 accepted)
            yield {
                0: DeltaToolCall(name="read_project_file", json_args='{"relative_path": "a.ets"}')
            }
            return
        if calls == 4:
            draft = DiagnosisReportDraft(
                verdict="insufficient_evidence",
                summary="两轮搜索均无命中,未获得源码观测",
                issue_category="unknown",
                confidence=0.2,
                missing_information=["可复现的日志"],
            )
            yield {
                0: DeltaToolCall(
                    name=SUBMIT_REPORT_TOOL,
                    json_args=json.dumps({"draft": draft.model_dump(mode="json")}),
                )
            }
            return
        yield "已如实说明证据缺口。"

    agent = _make_agent(tmp_path, monkeypatch, respond, tool_no_progress_limit=2)
    conversation = Conversation(workspace_path=str(tmp_path))
    events = [event async for event in agent.stream_turn(conversation, "搜索异常")]
    completed = next(event for event in events if isinstance(event, Completed))
    usage = completed.tool_usage

    assert usage["attempted"] == 4
    assert usage["accepted"] == 3  # 2 次搜索 + 1 次 submit;被拦截的 read 不计
    assert usage["blocked"] == 1  # 收尾拦截只计一次(预算侧)
    assert usage["executed"] == 3
    assert usage["pending"] == 0
    assert usage["attempted"] == usage["accepted"] + usage["blocked"]
    assert usage["no_new_observation_calls"] == 2  # 两次空搜索
    assert usage["report_attempts"] == 1
    assert usage["report_validation_failures"] == 0
    assert "已提交" in (usage["stop_reason"] or "")


async def test_expired_evidence_counts_expired_and_validation_failure(
    tmp_path, monkeypatch
) -> None:
    """引用已淘汰的证据 ID:账本命中墓碑计 evidence_expired,submit 真实
    执行后校验不过计 report_validation_failures;报告不成立。"""
    (tmp_path / "b.ets").write_text("new line\n")
    # 预置上一轮账本:max_entries=1,只有 a.ets 的旧观测
    seeded = EvidenceLedger(max_entries=1)
    seeded.capture(
        "read_project_file",
        {"relative_path": "a.ets"},
        {"path": "a.ets", "start_line": 1, "content": "old line"},
    )
    old_id = next(iter(seeded.entries))
    conversation = Conversation(workspace_path=str(tmp_path), evidence_state=seeded.snapshot())
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            # 本轮读 b.ets:旧观测(非本轮)被容量淘汰进墓碑
            yield {
                0: DeltaToolCall(name="read_project_file", json_args='{"relative_path": "b.ets"}')
            }
            return
        if calls == 2:
            draft = DiagnosisReportDraft(
                verdict="insufficient_evidence",
                summary="引用旧观测",
                issue_category="runtime",
                confidence=0.3,
                evidence=[EvidenceCitation(id=old_id, excerpt="old line", supports="旧读取")],
            )
            yield {
                0: DeltaToolCall(
                    name=SUBMIT_REPORT_TOOL,
                    json_args=json.dumps({"draft": draft.model_dump(mode="json")}),
                )
            }
            return
        yield "证据已过期,改为如实说明缺口。"

    agent = _make_agent(tmp_path, monkeypatch, respond)
    events = [event async for event in agent.stream_turn(conversation, "继续排查")]
    completed = next(event for event in events if isinstance(event, Completed))
    usage = completed.tool_usage

    assert completed.report is None
    assert usage["evidence_expired"] == 1
    assert usage["report_validation_failures"] == 1
    assert usage["report_attempts"] == 1
    assert usage["attempted"] == usage["accepted"] + usage["blocked"]


async def test_duplicate_failure_signature_counts_accepted_but_not_executed() -> None:
    """重复失败签名拒绝计入 accepted(已过预算入口),但不计 executed/reused;
    属预算内拒绝,不进 blocked;tool_call_id 到达登记可查。"""
    budget = ToolFailureBudget()
    failing = AsyncMock(side_effect=OSError("missing"))
    with pytest.raises(ToolFailed, match="OSError"):
        await budget.call("read_project_file", {"path": "x"}, failing, tool_call_id="t1")
    with pytest.raises(ToolFailed, match="禁止原样重试"):
        await budget.call("read_project_file", {"path": "x"}, failing, tool_call_id="t2")
    metrics = budget.metrics()
    assert metrics["accepted"] == 2
    assert metrics["calls"] == 2
    assert metrics["executed"] == 1
    assert metrics["reused"] == 0
    assert metrics["blocked"] == 0
    # accepted 内包含未执行的重复签名拒绝:不能无条件写成 executed + reused
    assert metrics["accepted"] != metrics["executed"] + metrics["reused"]
    assert budget.has_seen("t1") and budget.has_seen("t2")
    assert not budget.has_seen("t3")


async def test_submit_counters_split_attempts_and_validation_failures() -> None:
    """submit 真实执行但校验不过计 report_validation_failures;成功计
    report_attempts 不计 failures;重签名拦截的 submit 未执行,两者都不计。"""
    budget = ToolFailureBudget()
    bad = AsyncMock(side_effect=ToolFailed("报告校验未通过:unknown_evidence_id"))
    with pytest.raises(ToolFailed, match="unknown_evidence_id"):
        await budget.call(SUBMIT_REPORT_TOOL, {"draft": {"v": 1}}, bad)
    metrics = budget.metrics()
    assert metrics["report_attempts"] == 1
    assert metrics["report_validation_failures"] == 1
    assert metrics["executed"] == 1
    # 同签名原样重提:重签名拦截在预算内,未真实执行,submit 两类计数都不动
    with pytest.raises(ToolFailed, match="禁止原样重试"):
        await budget.call(SUBMIT_REPORT_TOOL, {"draft": {"v": 1}}, bad)
    metrics = budget.metrics()
    assert metrics["report_attempts"] == 1
    assert metrics["report_validation_failures"] == 1
    assert metrics["accepted"] == 2
    assert metrics["executed"] == 1
    # 修正后重提(签名不同)真实执行并成功
    good = AsyncMock(return_value={"status": "submitted"})
    await budget.call(SUBMIT_REPORT_TOOL, {"draft": {"v": 2}}, good)
    metrics = budget.metrics()
    assert metrics["report_attempts"] == 2
    assert metrics["report_validation_failures"] == 1
    assert metrics["submit_attempts"] == metrics["report_attempts"]
    assert budget.submit_succeeded


async def test_no_new_observation_calls_accumulate_reuse_and_empty_results() -> None:
    """no_new_observation_calls 是单调累计:复用与空结果/重复指纹都计入,
    不随 no_progress 被新进展清零而减少。"""
    budget = ToolFailureBudget()
    row = [{"path": "a.ets", "line": 1, "excerpt": "x"}]
    await budget.call("search_project_text", {"query": "q"}, AsyncMock(return_value=row))
    # 完全相同调用:复用,计一次无新增观测
    await budget.call("search_project_text", {"query": "q"}, AsyncMock(return_value=row))
    # 空结果:计一次无新增观测
    await budget.call("search_project_text", {"query": "other"}, AsyncMock(return_value=[]))
    metrics = budget.metrics()
    assert metrics["reused"] == 1
    assert metrics["no_new_observation_calls"] == 2


async def test_metrics_keeps_legacy_keys_and_only_adds_v2_keys() -> None:
    """向后兼容:旧键(calls/result_chars/submit_attempts 等)全部保留且
    语义不变,v2 新键只增不删,schema_version 标记口径版本。"""
    budget = ToolFailureBudget()
    await budget.call("read_project_file", {"path": "a"}, AsyncMock(return_value={"content": "x"}))
    metrics = budget.metrics()
    for legacy in (
        "calls",
        "executed",
        "reused",
        "result_chars",
        "evidence_restored",
        "submit_attempts",
        "stop_reason",
    ):
        assert legacy in metrics
    for added in (
        "schema_version",
        "accepted",
        "blocked",
        "report_attempts",
        "report_validation_failures",
        "no_new_observation_calls",
        "source_pages_truncated",
    ):
        assert added in metrics
    assert metrics["schema_version"] == 2
    assert metrics["calls"] == metrics["accepted"]
    # source_pages_truncated 本轮仅占位(分页协议由后续阶段实施)
    assert metrics["source_pages_truncated"] == 0


async def test_batch_calls_blocked_after_exhaustion_counted_once() -> None:
    """同一批次并发调用触发停止:锁串行下先到的放行、耗尽后到达的在预算内
    拦截计 blocked(预算侧),实际执行不超过预算;每个到达的 tool_call_id
    都登记 seen,事件层见到失败结果时不会重复归集。"""
    budget = ToolFailureBudget(call_limit=2, finalize_reserved=0)
    ok = AsyncMock(return_value={"content": "x"})
    results = await asyncio.gather(
        budget.call("read_project_file", {"path": "a.ets"}, ok, tool_call_id="t1"),
        budget.call("read_project_file", {"path": "b.ets"}, ok, tool_call_id="t2"),
        budget.call("read_project_file", {"path": "c.ets"}, ok, tool_call_id="t3"),
        return_exceptions=True,
    )
    succeeded = [result for result in results if not isinstance(result, ToolFailed)]
    rejected = [result for result in results if isinstance(result, ToolFailed)]
    assert len(succeeded) == 2  # 实际执行不超过预算
    assert len(rejected) == 1  # 耗尽后到达的在预算内被拦
    metrics = budget.metrics()
    assert metrics["accepted"] == 2
    assert metrics["executed"] == 2
    assert metrics["blocked"] == 1
    assert "调用预算已耗尽" in (metrics["stop_reason"] or "")
    # 被拦截的调用同样到达过预算入口:事件层按 seen 去重,不双计
    assert all(budget.has_seen(call_id) for call_id in ("t1", "t2", "t3"))


def test_pending_inflight_calls_not_forced_into_terminal_equation() -> None:
    """取消/异常留下在途调用时另记 pending:恒等式为
    attempted = accepted + blocked + pending,不硬套终态等式。"""
    budget = ToolFailureBudget()
    # 预算内状态:2 次放行(accepted),无前置拦截
    budget.calls = 2
    budget.executed = 2
    merged = merge_tool_usage(
        budget,
        attempted=5,
        rejected_before_budget=1,
        pending=2,
        evidence_expired=0,
        model_requests=3,
        elapsed_ms=1,
    )
    assert merged["accepted"] == 2
    assert merged["blocked"] == 1
    assert merged["pending"] == 2
    assert merged["attempted"] == merged["accepted"] + merged["blocked"] + merged["pending"]
    # 有在途时终态等式不成立是正常口径,差值恰为 pending
    assert merged["attempted"] != merged["accepted"] + merged["blocked"]
