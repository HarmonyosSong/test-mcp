from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from pydantic_ai import Agent, ModelMessagesTypeAdapter
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.exceptions import ModelRetry, ToolFailed
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from harmony_agent.agents import Completed, Failed, HarmonyChatAgent
from harmony_agent.config import Settings
from harmony_agent.domain import (
    Conversation,
    DiagnosisReport,
    Evidence,
    EvidenceKind,
    RootCauseCandidate,
)
from harmony_agent.domain.conversation import trim_messages_state
from harmony_agent.runtimes.evidence import EvidenceLedger
from harmony_agent.runtimes.history import prepare_history
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry
from harmony_agent.toolsets.failure_budget import BudgetedToolset, ToolFailureBudget
from harmony_agent.toolsets.skill_loader import build_skill_toolset


def test_compaction_keeps_tool_pair_and_does_not_mutate_input() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart("Which entry failed?")]),
        ModelResponse(parts=[TextPart("Was it history or new evaluation?")]),
        ModelRequest(parts=[UserPromptPart("History, on HarmonyOS.")]),
        ModelResponse(
            parts=[
                ToolCallPart("read_project_file", {"relative_path": "a.ets"}, tool_call_id="one")
            ]
        ),
        ModelRequest(
            parts=[ToolReturnPart("read_project_file", {"content": "x" * 8000}, tool_call_id="one")]
        ),
        ModelResponse(parts=[TextPart("The evidence is incomplete.")]),
    ]
    state = ModelMessagesTypeAdapter.dump_python(messages, mode="json")
    original = copy.deepcopy(state)
    trimmed = trim_messages_state(state, max_messages=4)
    restored = ModelMessagesTypeAdapter.validate_python(trimmed)
    parts = [part for message in restored for part in message.parts]

    assert state == original
    assert {p.tool_call_id for p in parts if isinstance(p, ToolCallPart)} == {"one"}
    assert {p.tool_call_id for p in parts if isinstance(p, ToolReturnPart)} == {"one"}
    serialized = json.dumps(trimmed)
    assert "Was it history or new evaluation?" in serialized
    assert "History, on HarmonyOS." in serialized
    assert "已截断" in json.dumps(trimmed, ensure_ascii=False)


def test_current_turn_is_kept_even_when_soft_message_limit_is_small() -> None:
    state = ModelMessagesTypeAdapter.dump_python(
        [
            ModelRequest(parts=[UserPromptPart("issue")]),
            ModelResponse(parts=[ToolCallPart("read", {}, tool_call_id="one")]),
            ModelRequest(parts=[ToolReturnPart("read", "result", tool_call_id="one")]),
            ModelResponse(parts=[TextPart("answer")]),
        ],
        mode="json",
    )
    assert trim_messages_state(state, max_messages=2) == state


async def test_history_is_compacted_before_next_model_request() -> None:
    tools = FunctionToolset()

    @tools.tool_plain
    def read_large() -> dict:
        return {"content": "x" * 20000}

    calls = 0

    def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(parts=[ToolCallPart("read_large", {})])
        returned = messages[-1].parts[0]
        assert isinstance(returned, ToolReturnPart)
        assert len(str(returned.content)) < 5000
        return ModelResponse(parts=[TextPart("Need a narrower source range.")])

    result = await Agent(
        FunctionModel(respond), toolsets=[tools], capabilities=[ProcessHistory(prepare_history)]
    ).run("inspect")
    assert "narrower" in result.output


async def test_loaded_skill_remains_complete_before_model_request_and_on_reuse() -> None:
    registry = SkillRegistry(Path(__file__).resolve().parents[2] / "skills")
    registry.load()
    body = registry.get("locate-harmony-issue").instructions
    assert len(body) > 4000
    budget = ToolFailureBudget()
    calls = 0

    def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 2:
            assert messages[-1].parts[0].content == body
        if calls <= 2:
            return ModelResponse(
                parts=[ToolCallPart("load_skill", {"name": "locate-harmony-issue"})]
            )
        assert messages[-1].parts[0].content["reused_from_call"] == 1
        assert any(
            isinstance(part, ToolReturnPart) and part.content == body
            for message in messages
            for part in message.parts
        )
        return ModelResponse(parts=[TextPart("Complete instructions retained.")])

    await Agent(
        FunctionModel(respond),
        toolsets=[BudgetedToolset(build_skill_toolset(registry), budget)],
        capabilities=[ProcessHistory(prepare_history)],
    ).run("inspect")
    assert budget.executed == 1


@pytest.mark.parametrize("name", ["lookup_issue", "get_knowledge_entry"])
def test_bounded_knowledge_structure_survives_history_compaction(name: str) -> None:
    payload = {"body": "criterion " * 600, "next_offset": 6000, "truncated": True}
    messages = [
        ModelRequest(parts=[UserPromptPart("issue")]),
        ModelResponse(parts=[ToolCallPart(name, {}, tool_call_id="one")]),
        ModelRequest(parts=[ToolReturnPart(name, payload, tool_call_id="one")]),
    ]
    restored = prepare_history(messages)
    assert restored[-1].parts[0].content == payload


async def test_success_reuse_reduces_execution_and_return_volume() -> None:
    budget = ToolFailureBudget()
    operation = AsyncMock(return_value={"content": "x" * 10000})
    first = await budget.call("read_project_file", {"path": "a.ets"}, operation)
    second = await budget.call("read_project_file", {"path": "a.ets"}, operation)
    assert operation.await_count == 1
    assert second["reused_from_call"] == 1
    assert len(json.dumps(second)) < len(json.dumps(first)) / 10
    assert budget.metrics()["reused"] == 1


async def test_empty_searches_stop_and_new_turn_has_fresh_budget() -> None:
    budget = ToolFailureBudget(no_progress_limit=2)
    empty = AsyncMock(return_value=[])
    await budget.call("search_knowledge", {"query": "one"}, empty)
    await budget.call("search_knowledge", {"query": "two"}, empty)
    with pytest.raises(ToolFailed, match="没有新增信息"):
        await budget.call("search_knowledge", {"query": "three"}, empty)
    assert empty.await_count == 2
    fresh = ToolFailureBudget()
    assert await fresh.call("search_knowledge", {"query": "one"}, empty) == []


async def test_rebinding_invalidates_reusable_results() -> None:
    budget = ToolFailureBudget()
    read = AsyncMock(side_effect=["old source", "new source"])
    await budget.call("read_project_file", {"path": "a.ets"}, read)
    await budget.call(
        "bind_repository", {"name_or_url": "another"}, AsyncMock(return_value="bound")
    )
    assert await budget.call("read_project_file", {"path": "a.ets"}, read) == "new source"


async def test_rebinding_allows_a_previously_missing_file_to_be_read() -> None:
    budget = ToolFailureBudget()
    with pytest.raises(ToolFailed):
        await budget.call(
            "read_project_file", {"path": "a.ets"}, AsyncMock(side_effect=OSError("missing"))
        )
    await budget.call(
        "bind_repository", {"name_or_url": "another"}, AsyncMock(return_value="bound")
    )
    assert (
        await budget.call("read_project_file", {"path": "a.ets"}, AsyncMock(return_value="exists"))
        == "exists"
    )


async def test_identical_results_under_different_queries_count_as_no_progress() -> None:
    budget = ToolFailureBudget(no_progress_limit=2)
    operation = AsyncMock(return_value=[{"path": "a.ets", "line": 1, "excerpt": "same line"}])
    for query in ("first", "second", "third"):
        await budget.call("search_project_text", {"query": query}, operation)
    assert budget.exhausted
    assert budget.no_progress == 2


async def test_successful_calls_hit_total_budget_then_allow_final_answer() -> None:
    budget = ToolFailureBudget(call_limit=2)
    tools = FunctionToolset()

    @tools.tool_plain
    def read_project_file(path: str) -> str:
        return path

    calls = 0

    def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls <= 2:
            return ModelResponse(parts=[ToolCallPart("read_project_file", {"path": str(calls)})])
        assert not info.function_tools
        return ModelResponse(
            parts=[TextPart("Evidence incomplete; please provide the failing log.")]
        )

    result = await Agent(FunctionModel(respond), toolsets=[BudgetedToolset(tools, budget)]).run(
        "inspect"
    )
    assert "incomplete" in result.output
    assert budget.executed == 2


def observed_report(ledger: EvidenceLedger) -> DiagnosisReport:
    ledger.capture(
        "read_project_file",
        {"relative_path": "a.ets"},
        {"path": "a.ets", "start_line": 1, "content": "1: throw Error('boom');"},
    )
    evidence = next(iter(ledger.entries.values()))
    return DiagnosisReport(
        verdict="probable",
        summary="Candidate",
        issue_category="runtime",
        confidence=0.6,
        evidence=[evidence],
        root_cause_candidates=[
            RootCauseCandidate(
                title="Candidate",
                explanation="Throwing branch",
                confidence=0.6,
                evidence_ids=[evidence.id],
            )
        ],
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", "invented"),
        ("excerpt", "invented source"),
        ("location", "other.ets:99"),
    ],
)
def test_runtime_rejects_forged_evidence(field, value) -> None:
    ledger = EvidenceLedger()
    report = observed_report(ledger)
    report.evidence[0] = report.evidence[0].model_copy(update={field: value})
    with pytest.raises(ModelRetry):
        ledger.validate(report)


def test_rejection_lists_observed_ids_for_self_correction() -> None:
    """拦回伪造 ID 时必须给出已观测 ID 清单:只说一句 "use runtime IDs" 会让长上下文
    里的模型凭格式编造(实测 e1 → ev-短hex → ev-伪16hex 三连编),清单让它可直接照抄。"""
    ledger = EvidenceLedger()
    report = observed_report(ledger)
    observed_id = report.evidence[0].id
    report.evidence[0] = report.evidence[0].model_copy(update={"id": "e1"})
    with pytest.raises(ModelRetry, match=observed_id):
        ledger.validate(report)


def test_user_evidence_must_quote_actual_user_words() -> None:
    """kind=user 证据不进观测账本(提交时才有 ID),核的是摘录必须为用户原话——
    既放行合法的现象登记,也防止编造"用户没说过的话"撑现象。"""
    ledger = EvidenceLedger(input_texts=["家长反馈可选择PDF文件但点击完成后返回首页"])
    report = observed_report(ledger)
    report.evidence.append(
        Evidence(
            kind=EvidenceKind.USER,
            source="user-message",
            excerpt="可选择PDF文件但点击完成后返回首页",
            supports="用户报告的原始现象",
        )
    )
    ledger.validate(report)
    report.evidence[-1] = report.evidence[-1].model_copy(update={"excerpt": "用户说闪退黑屏"})
    with pytest.raises(ModelRetry, match="verbatim"):
        ledger.validate(report)


def test_user_only_positive_candidate_rejected_without_keyerror() -> None:
    """正向候选只挂 USER 证据时必须明确拒绝(ModelRetry),不能因 USER 不进账本
    而在 entries[eid] 处裸抛 KeyError。"""
    ledger = EvidenceLedger(input_texts=["家长反馈可选择PDF文件但点击完成后返回首页"])
    report = observed_report(ledger).model_dump()
    user_evidence = Evidence(
        kind=EvidenceKind.USER,
        source="user-message",
        excerpt="可选择PDF文件但点击完成后返回首页",
        supports="用户报告的原始现象",
    )
    report["evidence"] = [user_evidence.model_dump(mode="json")]
    report["root_cause_candidates"] = [
        {
            "title": "only user",
            "explanation": "x",
            "confidence": 0.5,
            "evidence_ids": [user_evidence.id],
        }
    ]
    with pytest.raises(ModelRetry, match="observed source or log"):
        ledger.validate(DiagnosisReport.model_validate(report))


def test_trim_annotates_truncation_with_original_size() -> None:
    """截断必须附原始长度:模型要知道丢了多少,才能判断是否需要按行号精准补读,
    而不是把残文当全部(实测因此反复通读文件头)。"""
    state = [
        {"role": "user", "parts": [{"part_kind": "user-prompt", "content": "q"}]},
        {
            "role": "model",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "read_project_file",
                    "content": "x" * 9000,
                }
            ],
        },
    ]
    trimmed = trim_messages_state(state)
    content = trimmed[1]["parts"][0]["content"]
    assert "原文共 9000 字符" in content


def test_every_positive_candidate_needs_valid_evidence() -> None:
    report = observed_report(EvidenceLedger()).model_dump()
    report["root_cause_candidates"].append(
        {
            "title": "unsupported",
            "explanation": "guess",
            "confidence": 0.9,
            "evidence_ids": [],
        }
    )
    with pytest.raises(ValidationError, match="every candidate"):
        DiagnosisReport.model_validate(report)


def test_knowledge_and_fabricated_parser_inputs_do_not_register_evidence() -> None:
    ledger = EvidenceLedger(input_texts=["actual user input"])
    ledger.capture("get_knowledge_entry", {}, {"authority": "code", "body": "claimed cause"})
    ledger.capture(
        "parse_hilog",
        {"log_text": "fabricated Error"},
        {"error_lines": [{"line": 1, "excerpt": "fabricated Error"}]},
    )
    assert ledger.entries == {}


def test_user_guess_is_not_promoted_to_log_evidence() -> None:
    """用户猜测即使有输入材料佐证，也不能通过日志解析升级为证据。"""
    guess = "我猜可能是 Checkout.ets 的 TypeError，但没有抓到日志。"
    ledger = EvidenceLedger(input_texts=["仅补充：昨晚出现过一次。"])
    parsed = ledger.capture(
        "parse_hilog",
        {"log_text": guess},
        {"error_lines": [{"line": 1, "excerpt": guess}]},
    )
    assert not parsed["evidence_refs"]
    assert ledger.entries == {}


def test_pasted_log_registers_with_line_locations() -> None:
    pasted = "正常信息\nError actual failure"
    ledger = EvidenceLedger(input_texts=[f"帮忙看下日志：\n{pasted}"])
    parsed = ledger.capture(
        "parse_hilog",
        {"log_text": pasted},
        {"error_lines": [{"line": 2, "excerpt": "Error actual failure"}]},
    )
    assert len(parsed["evidence_refs"]) == 1
    entry = next(iter(ledger.entries.values()))
    assert entry.kind == EvidenceKind.LOG
    assert entry.location == "pasted-hilog:2"


def test_ledger_snapshot_round_trip_and_cap() -> None:
    """新生命周期(替代旧的单纯 FIFO):本轮观测受保护不被历史容量淘汰;
    跨轮 restore 后保护集清空,旧观测才可淘汰,淘汰者留墓碑。"""
    ledger = EvidenceLedger(max_entries=2)
    for index in range(3):
        ledger.capture(
            "read_project_file",
            {"relative_path": f"{index}.ets"},
            {"path": f"{index}.ets", "start_line": 1, "content": f"line {index}"},
        )
    # 本轮三条全受保护:不淘汰
    assert len(ledger.entries) == 3
    restored = EvidenceLedger.restore(ledger.snapshot(), input_texts=[])
    assert set(restored.entries) == set(ledger.entries)
    assert restored.texts == ledger.texts
    # 新一轮:新增观测触发淘汰,最旧的历史先进先出
    restored.capture(
        "read_project_file",
        {"relative_path": "3.ets"},
        {"path": "3.ets", "start_line": 1, "content": "line 3"},
    )
    assert len(restored.entries) == 2
    locations = [entry.location for entry in restored.entries.values()]
    assert "0.ets:1" not in locations and "1.ets:1" not in locations
    assert len(restored._evicted) == 2  # 淘汰者留墓碑
    assert EvidenceLedger.restore({"entries": [{"broken": True}]}, []).entries == {}


def test_evicted_id_reports_expired_and_unknown_lists_available() -> None:
    """过期 ID 报 expired + 原观测位置;从未出现的 ID 报 unknown + 可用清单。"""
    ledger = EvidenceLedger(max_entries=1)
    ledger.capture(
        "read_project_file",
        {"relative_path": "a.ets"},
        {"path": "a.ets", "start_line": 1, "content": "old"},
    )
    old_id = next(iter(ledger.entries))
    round2 = EvidenceLedger.restore(ledger.snapshot(), input_texts=[])
    round2.capture(
        "read_project_file",
        {"relative_path": "b.ets"},
        {"path": "b.ets", "start_line": 1, "content": "new"},
    )
    assert old_id not in round2.entries and old_id in round2._evicted
    report = DiagnosisReport(
        verdict="probable",
        summary="s",
        issue_category="c",
        confidence=0.5,
        evidence=[
            Evidence(
                id=old_id,
                kind=EvidenceKind.SOURCE,
                source="mcp:read_project_file",
                location="a.ets:1",
                excerpt="old",
                supports="x",
            )
        ],
        root_cause_candidates=[
            RootCauseCandidate(title="t", explanation="e", confidence=0.5, evidence_ids=[old_id])
        ],
    )
    with pytest.raises(ModelRetry, match="expired"):
        round2.validate(report)
    report.evidence[0] = report.evidence[0].model_copy(update={"id": "ev-forged"})
    with pytest.raises(ModelRetry, match="unknown"):
        round2.validate(report)


def test_rereading_identical_content_restores_evicted_id() -> None:
    """ID 是内容哈希:重读同内容恢复同一 ID,墓碑消除并计 restored。"""
    ledger = EvidenceLedger(max_entries=1)
    args = {"relative_path": "a.ets"}
    row = {"path": "a.ets", "start_line": 1, "content": "same"}
    ledger.capture("read_project_file", args, row)
    old_id = next(iter(ledger.entries))
    round2 = EvidenceLedger.restore(ledger.snapshot(), input_texts=[])
    round2.capture(
        "read_project_file",
        {"relative_path": "b.ets"},
        {"path": "b.ets", "start_line": 1, "content": "other"},
    )
    assert old_id in round2._evicted
    round2.capture("read_project_file", args, row)
    assert old_id in round2.entries and old_id not in round2._evicted
    assert round2.restored_count == 1


def test_current_turn_capacity_rejects_admission_without_ids() -> None:
    """达到当前轮硬上限时拒绝接纳:该行不产出可引用 ID,并明确标记容量已满。"""
    ledger = EvidenceLedger(max_current_turn=1)
    first = ledger.capture(
        "read_project_file",
        {"relative_path": "a.ets"},
        {"path": "a.ets", "start_line": 1, "content": "one"},
    )
    assert len(first["evidence_refs"]) == 1
    second = ledger.capture(
        "read_project_file",
        {"relative_path": "b.ets"},
        {"path": "b.ets", "start_line": 1, "content": "two"},
    )
    assert second["observation_capacity_reached"] is True
    assert second["evidence_refs"] == []


@pytest.mark.parametrize("model_fails", [False, True])
async def test_chat_records_usage_and_validates_report(
    tmp_path: Path, monkeypatch, model_fails: bool
) -> None:
    (tmp_path / "a.ets").write_text("throw Error('boom');\n")
    root = Path(__file__).resolve().parents[2]
    registry = SkillRegistry(root / "skills")
    registry.load()
    gateway = ModelGateway(
        Settings(
            _env_file=None,
            knowledge_root=root / "knowledge",
            model_config_file=tmp_path / "model.json",
        )
    )
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {
                0: DeltaToolCall(name="read_project_file", json_args='{"relative_path": "a.ets"}')
            }
            return
        if model_fails:
            raise RuntimeError("upstream failed after source read")
        if calls >= 3:
            yield "报告已提交：a.ets 抛出点高度可疑。"
            return
        payload = messages[-1].parts[0].content
        reference = payload["evidence_refs"][0]
        report = DiagnosisReport(
            verdict="probable",
            summary="Throwing branch",
            issue_category="runtime",
            confidence=0.6,
            evidence=[
                Evidence(**reference, excerpt=payload["result"]["content"], supports="Throw")
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
        yield {
            0: DeltaToolCall(
                name="submit_diagnosis_report",
                json_args=json.dumps({"report": report.model_dump(mode="json")}),
            )
        }

    monkeypatch.setattr(
        gateway, "get_model_for", AsyncMock(return_value=FunctionModel(stream_function=respond))
    )
    agent = HarmonyChatAgent(registry, gateway)
    conversation = Conversation(workspace_path=str(tmp_path))
    events = [event async for event in agent.stream_turn(conversation, "排查 a.ets 的异常")]
    if model_fails:
        failed = next(event for event in events if isinstance(event, Failed))
        assert "upstream failed" in failed.error
        assert failed.evidence_state["entries"]
        assert failed.tool_usage["executed"] == 1
        return
    completed = next(event for event in events if isinstance(event, Completed))
    assert completed.report is not None
    assert completed.report.verdict == "probable"
    assert completed.evidence_state["entries"]
    assert completed.tool_usage["executed"] == 2
    assert completed.tool_usage["model_requests"] == 3


async def test_chat_rejects_forged_report_evidence(tmp_path: Path, monkeypatch) -> None:
    root = Path(__file__).resolve().parents[2]
    registry = SkillRegistry(root / "skills")
    registry.load()
    gateway = ModelGateway(
        Settings(
            _env_file=None,
            knowledge_root=root / "knowledge",
            model_config_file=tmp_path / "model.json",
        )
    )
    calls = 0

    async def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            forged_evidence = Evidence(
                kind=EvidenceKind.SOURCE,
                source="mcp:read_project_file",
                location="a.ets:1",
                excerpt="never observed",
                supports="forged",
            )
            forged = DiagnosisReport(
                verdict="probable",
                summary="forged",
                issue_category="runtime",
                confidence=0.9,
                evidence=[forged_evidence],
                root_cause_candidates=[
                    RootCauseCandidate(
                        title="forged",
                        explanation="forged",
                        confidence=0.9,
                        evidence_ids=[forged_evidence.id],
                    )
                ],
            )
            yield {
                0: DeltaToolCall(
                    name="submit_diagnosis_report",
                    json_args=json.dumps({"report": forged.model_dump(mode="json")}),
                )
            }
            return
        assert calls == 2
        returned = messages[-1].parts[0]
        assert isinstance(returned, ToolReturnPart) or "Retry" in type(returned).__name__
        yield "校验未通过，改为如实说明证据缺口。"

    monkeypatch.setattr(
        gateway, "get_model_for", AsyncMock(return_value=FunctionModel(stream_function=respond))
    )
    agent = HarmonyChatAgent(registry, gateway)
    events = [event async for event in agent.stream_turn(Conversation(), "直接出报告")]
    completed = next(event for event in events if isinstance(event, Completed))
    assert completed.report is None
    assert "缺口" in completed.text
