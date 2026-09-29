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
    DiagnosisReportDraft,
    EvidenceCitation,
    EvidenceKind,
    RootCauseCandidate,
)
from harmony_agent.domain.conversation import trim_messages_state
from harmony_agent.runtimes.evidence import EvidenceLedger
from harmony_agent.runtimes.history import prepare_history
from harmony_agent.runtimes.model_gateway import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry
from harmony_agent.toolsets.failure_budget import BudgetedToolset, ToolFailureBudget
from harmony_agent.toolsets.report_submission import SUBMIT_REPORT_TOOL
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
    # no_progress 打满不再全停:进入收尾阶段,普通工具被拒绝并引导 submit
    with pytest.raises(ToolFailed, match="收尾"):
        await budget.call("search_knowledge", {"query": "three"}, empty)
    assert empty.await_count == 2
    assert budget.finalize_only and not budget.exhausted
    # submit 放行;新一轮预算全新
    await budget.call(
        SUBMIT_REPORT_TOOL, {"draft": {}}, AsyncMock(return_value={"status": "submitted"})
    )
    assert budget.submit_succeeded
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
    # 相同结果集不算新信息:no_progress 打满进入收尾阶段(不再是全停)
    assert budget.no_progress == 2
    assert budget.finalize_only and not budget.exhausted


async def test_successful_calls_hit_total_budget_then_allow_final_answer() -> None:
    budget = ToolFailureBudget(call_limit=4)
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


def observed_draft(ledger: EvidenceLedger) -> DiagnosisReportDraft:
    ledger.capture(
        "read_project_file",
        {"relative_path": "a.ets"},
        {"path": "a.ets", "start_line": 1, "content": "1: throw Error('boom');"},
    )
    evidence = next(iter(ledger.entries.values()))
    return DiagnosisReportDraft(
        verdict="probable",
        summary="Candidate",
        issue_category="runtime",
        confidence=0.6,
        evidence=[
            EvidenceCitation(
                id=evidence.id,
                excerpt="throw Error('boom')",
                supports="抛出点观测",
            )
        ],
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
    ],
)
def test_runtime_rejects_forged_evidence(field, value) -> None:
    ledger = EvidenceLedger()
    draft = observed_draft(ledger)
    draft.evidence[0] = draft.evidence[0].model_copy(update={field: value})
    with pytest.raises(ModelRetry):
        ledger.resolve_draft(draft)


def test_draft_forbids_provenance_fields() -> None:
    """引用式草稿只收 id/excerpt/supports:模型填 kind/source/location 会被 schema
    直接拒绝(extra=forbid)——出处由账本组装,模型无从伪造,也就不存在
    「出处与账本不一致」这一类失败往返。"""
    with pytest.raises(ValidationError):
        DiagnosisReportDraft.model_validate(
            {
                "verdict": "probable",
                "summary": "s",
                "issue_category": "c",
                "confidence": 0.5,
                "evidence": [
                    {"id": "ev-x", "excerpt": "y", "supports": "z", "location": "a.ets:1"}
                ],
            }
        )


def test_resolve_draft_assembles_provenance_from_ledger() -> None:
    """解析成功路径:kind/source/location 由账本组装,摘录取模型提交的逐字子串。"""
    ledger = EvidenceLedger()
    draft = observed_draft(ledger)
    report = ledger.resolve_draft(draft)
    observed = next(iter(ledger.entries.values()))
    item = report.evidence[0]
    assert item.kind is EvidenceKind.SOURCE
    assert item.source == observed.source and item.location == observed.location
    assert item.excerpt == "throw Error('boom')"
    assert report.verdict == "probable"


def test_rejection_lists_observed_ids_for_self_correction() -> None:
    """拦回伪造 ID 时必须给出已观测 ID 清单:只说一句 "use runtime IDs" 会让长上下文
    里的模型凭格式编造(实测 e1 → ev-短hex → ev-伪16hex 三连编),清单让它可直接照抄。"""
    ledger = EvidenceLedger()
    draft = observed_draft(ledger)
    observed_id = draft.evidence[0].id
    draft.evidence[0] = draft.evidence[0].model_copy(update={"id": "e1"})
    with pytest.raises(ModelRetry, match=observed_id):
        ledger.resolve_draft(draft)


def test_user_evidence_must_quote_actual_user_words() -> None:
    """用户引用走 register_user_texts 登记(ev-user-*,内容哈希):摘录必须逐字摘自
    该条用户消息;解析成功时出处由账本组装为 kind=user。"""
    ledger = EvidenceLedger(input_texts=["家长反馈可选择PDF文件但点击完成后返回首页"])
    refs = ledger.register_user_texts()
    draft = observed_draft(ledger)
    draft.evidence.append(
        EvidenceCitation(
            id=refs[0]["id"],
            excerpt="可选择PDF文件但点击完成后返回首页",
            supports="用户报告的原始现象",
        )
    )
    report = ledger.resolve_draft(draft)
    user_item = report.evidence[-1]
    assert user_item.kind is EvidenceKind.USER
    assert user_item.source == "user-message"
    draft.evidence[-1] = draft.evidence[-1].model_copy(update={"excerpt": "用户说闪退黑屏"})
    with pytest.raises(ModelRetry, match="excerpt_mismatch"):
        ledger.resolve_draft(draft)


def test_user_only_positive_candidate_rejected_without_keyerror() -> None:
    """正向候选只挂用户引用时必须明确拒绝(positive_without_observed_source):
    用户引用只支撑现象存在,不计入机制类根因的观测要求。"""
    ledger = EvidenceLedger(input_texts=["家长反馈可选择PDF文件但点击完成后返回首页"])
    uid = ledger.register_user_texts()[0]["id"]
    draft = DiagnosisReportDraft(
        verdict="probable",
        summary="s",
        issue_category="c",
        confidence=0.5,
        evidence=[
            EvidenceCitation(
                id=uid,
                excerpt="可选择PDF文件但点击完成后返回首页",
                supports="用户报告的原始现象",
            )
        ],
        root_cause_candidates=[
            RootCauseCandidate(title="t", explanation="e", confidence=0.5, evidence_ids=[uid])
        ],
    )
    with pytest.raises(ModelRetry, match="positive_without_observed_source"):
        ledger.resolve_draft(draft)


def test_capture_registers_only_delivered_search_matches() -> None:
    """SearchPage 形态:只有 matches 里的实际命中进账本;locator_hint/next_cursor
    等元数据不是观测,不得登记;返回保持页结构不变。"""
    ledger = EvidenceLedger()
    page = {
        "query": "onShowFileSelector",
        "file_glob": "**/*",
        "matches": [
            {"path": "a.ets", "line": 10, "excerpt": "onShowFileSelector((event) => ..."},
            {"path": "b.ets", "line": 20, "excerpt": "onShowFileSelector(callback)"},
        ],
        "truncated": False,
        "scanned_files": 3,
        "scan_limit_reached": False,
        "next_cursor": None,
        "locator_hint": "知识索引已给出位置:`onShowFileSelector` 已索引于 a.ets:10",
    }
    captured = ledger.capture("search_project_text", {"query": "onShowFileSelector"}, page)
    assert captured["result"] == page  # 页结构(含 hint 元数据)原样带给模型
    assert len(captured["evidence_refs"]) == 2
    locations = {entry.location for entry in ledger.entries.values()}
    assert locations == {"a.ets:10", "b.ets:20"}
    assert all("已索引" not in entry.excerpt for entry in ledger.entries.values())


def test_trim_preserves_bounded_pages_but_cuts_uncontrolled_returns() -> None:
    """有界页(FileContent/SearchPage + 引用元数据)通过 schema+大小复核后完整保留,
    runtime 不二次截坏;旧版/不受控的同名工具返回仍被结构化截断。"""
    bounded_read = {
        "path": "a.ets",
        "start_line": 1,
        "end_line": 95,
        "requested_end_line": 200,
        "total_lines": 430,
        "content": "\n".join(f"{n}: {'x' * 50}" for n in range(1, 96)),  # 超过 4000 字符
        "truncated": True,
        "next_line": 96,
        "has_more_in_file": True,
        "truncation_reason": "character_budget",
        "skipped_lines": [],
    }
    wrapped_page = {
        "evidence_refs": [{"id": "ev-1", "kind": "source", "source": "mcp:read_project_file"}],
        "result": {
            "query": "q",
            "file_glob": "**/*",
            "matches": [{"path": "a.ets", "line": n, "excerpt": "y" * 400} for n in range(10)],
            "truncated": False,
            "scanned_files": 3,
            "scan_limit_reached": False,
            "next_cursor": None,
        },
    }
    uncontrolled = {"path": "a.ets", "content": "z" * 9000}  # 旧版形态,无分页字段
    state = [
        {"role": "user", "parts": [{"part_kind": "user-prompt", "content": "q"}]},
        {
            "role": "model",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "read_project_file",
                    "content": bounded_read,
                },
                {
                    "part_kind": "tool-return",
                    "tool_name": "search_project_text",
                    "content": wrapped_page,
                },
                {
                    "part_kind": "tool-return",
                    "tool_name": "read_project_file",
                    "content": uncontrolled,
                },
            ],
        },
    ]
    trimmed = trim_messages_state(state)
    parts = trimmed[1]["parts"]
    # 有界页:整页保留,一个字符都不少
    assert parts[0]["content"] == bounded_read
    assert parts[1]["content"] == wrapped_page
    # 不受控返回:结构化截断说明 + 可读摘录,且仍是合法 JSON(不再拦腰切字符串)
    cut = parts[2]["content"]
    assert cut["runtime_truncated"] is True
    assert cut["original_chars"] > 9000
    assert "已截断" in cut["note"]
    assert cut["content_preview"].startswith('{"path": "a.ets"')
    json.dumps(trimmed)  # 整棵状态树可序列化


def test_trim_drops_oversized_fake_page_from_exemption() -> None:
    """结构像页但超过协议硬上限的返回不豁免裁剪:不能给同名工具结果无条件免裁剪。"""
    oversized_fake_page = {
        "path": "a.ets",
        "start_line": 1,
        "end_line": 95,
        "requested_end_line": 200,
        "total_lines": 430,
        "content": "x" * 20_000,  # 超过 12000 的协议硬上限
        "truncated": True,
        "next_line": 96,
        "has_more_in_file": True,
        "truncation_reason": "character_budget",
    }
    state = [
        {"role": "user", "parts": [{"part_kind": "user-prompt", "content": "q"}]},
        {
            "role": "model",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "read_project_file",
                    "content": oversized_fake_page,
                }
            ],
        },
    ]
    trimmed = trim_messages_state(state)
    cut = trimmed[1]["parts"][0]["content"]
    assert cut["runtime_truncated"] is True and cut["original_chars"] > 20_000


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
    draft = observed_draft(EvidenceLedger()).model_dump()
    draft["root_cause_candidates"].append(
        {
            "title": "unsupported",
            "explanation": "guess",
            "confidence": 0.9,
            "evidence_ids": [],
        }
    )
    with pytest.raises(ValidationError, match="every candidate"):
        DiagnosisReportDraft.model_validate(draft)


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
    draft = DiagnosisReportDraft(
        verdict="insufficient_evidence",
        summary="s",
        issue_category="c",
        confidence=0.5,
        evidence=[EvidenceCitation(id=old_id, excerpt="old", supports="x")],
    )
    with pytest.raises(ModelRetry, match="evidence_expired"):
        round2.resolve_draft(draft)
    draft.evidence[0] = draft.evidence[0].model_copy(update={"id": "ev-forged"})
    with pytest.raises(ModelRetry, match="unknown_evidence_id"):
        round2.resolve_draft(draft)


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
        draft = DiagnosisReportDraft(
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
        yield {
            0: DeltaToolCall(
                name="submit_diagnosis_report",
                json_args=json.dumps({"draft": draft.model_dump(mode="json")}),
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
            # 伪造一个从未被观测的引用 ID:出处字段已无法填写(extra=forbid),
            # 账本按 unknown_evidence_id 拦回并附可用清单。
            forged = DiagnosisReportDraft(
                verdict="probable",
                summary="forged",
                issue_category="runtime",
                confidence=0.9,
                evidence=[
                    EvidenceCitation(id="ev-forged", excerpt="never observed", supports="forged")
                ],
                root_cause_candidates=[
                    RootCauseCandidate(
                        title="forged",
                        explanation="forged",
                        confidence=0.9,
                        evidence_ids=["ev-forged"],
                    )
                ],
            )
            yield {
                0: DeltaToolCall(
                    name="submit_diagnosis_report",
                    json_args=json.dumps({"draft": forged.model_dump(mode="json")}),
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


async def test_no_progress_enters_finalize_only_instead_of_full_stop() -> None:
    """no_progress 打满不再全停:进入收尾阶段,普通工具被拒绝并引导 submit,
    submit 放行且成功后收尾。避免实测中「停止后拒绝 4 次」的纯消耗往返。"""
    budget = ToolFailureBudget(call_limit=30, no_progress_limit=2)

    async def empty_search() -> dict:
        return {"hits": []}

    async def submit_ok() -> dict:
        return {"status": "submitted"}

    await budget.call("search_project_text", {"query": "a"}, empty_search)
    assert not budget.finalize_only
    await budget.call("search_project_text", {"query": "b"}, empty_search)
    assert budget.finalize_only
    assert not budget.exhausted  # 不是停止,是收尾
    with pytest.raises(ToolFailed, match="收尾"):
        await budget.call("read_project_file", {"relative_path": "a.ets"}, empty_search)
    await budget.call(SUBMIT_REPORT_TOOL, {"draft": {}}, submit_ok)
    assert budget.submit_succeeded
    assert "已提交" in (budget.stop_reason or "")
    assert budget.exhausted


async def test_finalize_submit_attempts_exhaustion_stops_turn() -> None:
    """收尾阶段 submit 连续失败达到 finalize_attempt_limit 后全停:给修正机会,
    但不允许无限提交。注意每次提交的 draft 不同(修正后重提),签名不同才真实执行。"""
    budget = ToolFailureBudget(call_limit=30, no_progress_limit=1)

    async def empty_search() -> dict:
        return {"hits": []}

    async def bad_submit() -> dict:
        raise ToolFailed("报告校验未通过:unknown_evidence_id")

    await budget.call("search_project_text", {"query": "a"}, empty_search)
    assert budget.finalize_only
    for attempt in range(3):
        with pytest.raises(ToolFailed, match="unknown_evidence_id"):
            await budget.call(SUBMIT_REPORT_TOOL, {"draft": {"attempt": attempt}}, bad_submit)
    assert "收尾提交尝试已耗尽" in (budget.stop_reason or "")
    assert budget.exhausted


async def test_call_margin_enters_finalize_to_reserve_budget_for_submit() -> None:
    """调用余量进入 finalize_reserved 范围即进入收尾:把最后的调用保留给报告提交,
    防止预算耗尽瞬间连 submit 都发不出。"""
    budget = ToolFailureBudget(call_limit=5, finalize_reserved=2)

    async def ok() -> dict:
        return {"content": "x"}

    async def submit_ok() -> dict:
        return {"status": "submitted"}

    for i in range(3):
        await budget.call("read_project_file", {"relative_path": f"{i}.ets"}, ok)
    assert budget.calls == 3
    assert budget.finalize_only
    with pytest.raises(ToolFailed, match="收尾"):
        await budget.call("read_project_file", {"relative_path": "d.ets"}, ok)
    await budget.call(SUBMIT_REPORT_TOOL, {"draft": {}}, submit_ok)
    assert budget.submit_succeeded
