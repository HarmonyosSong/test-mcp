"""V2 检索框架阶段一合同测试:模式解析、配置校验、快照标识、版本化输出与日志。

对应 docs/knowledge-retrieval-v2-design.md 第 4/9/10/11 节;V2 引擎主体属阶段三,
本文件只锁定双模式框架的既有承诺。样例条目自包含,不依赖 knowledge/ 当前内容。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastmcp import Client
from test_knowledge_base import DEMO_ALIAS, DEMO_PHRASE, write_sample_entries

from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.preview_selection import (
    DIRECT_HIT,
    REFERENCE_ONLY,
    RELEVANT_REFERENCE,
    select_previews,
)
from harmony_knowledge_mcp.query_log import main as query_log_main
from harmony_knowledge_mcp.retrieval_v2 import (
    RETRIEVAL_VERSION_V1,
    SCORE_KIND_V1,
    STATUS_LEGACY,
    RetrievalConfig,
    RetrievalConfigError,
    build_snapshot_id,
    resolve_mode,
)
from harmony_knowledge_mcp.schemas import (
    Authority,
    End,
    KnowledgeEntry,
    KnowledgeKind,
    SearchHit,
)
from harmony_knowledge_mcp.server import create_knowledge_server


def test_resolve_mode_defaults_to_legacy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE", raising=False)
    assert resolve_mode() == "legacy"
    assert resolve_mode(None) == "legacy"
    assert resolve_mode("") == "legacy"


def test_resolve_mode_rejects_unknown_value() -> None:
    with pytest.raises(RetrievalConfigError, match="非法"):
        resolve_mode("turbo")


def test_shadow_mode_fails_fast_until_stage_four(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    with pytest.raises(RetrievalConfigError, match="阶段四"):
        create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode="shadow")
    # v2 模式已可用(阶段三交付)
    create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode="v2")


def test_config_rejects_out_of_range_and_unbalanced_weights() -> None:
    with pytest.raises(RetrievalConfigError, match="\\[0,1\\]"):
        RetrievalConfig(min_raw_score=1.5)
    with pytest.raises(RetrievalConfigError, match="之和必须为 1"):
        RetrievalConfig(weight_object=0.9)


def test_snapshot_id_is_stable_order_independent_and_content_sensitive(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)

    config = RetrievalConfig()
    entries = KnowledgeBase(tmp_path).load()
    first = build_snapshot_id(entries, root=tmp_path, rules_digest="r", config=config)
    shuffled = list(reversed(entries))
    assert build_snapshot_id(shuffled, root=tmp_path, rules_digest="r", config=config) == first
    assert build_snapshot_id(entries, root=tmp_path, rules_digest="r2", config=config) != first

    entry_path = next(tmp_path.rglob("*.md"))
    entry_path.write_text(entry_path.read_text(encoding="utf-8") + "\n补充一行\n", encoding="utf-8")
    changed = KnowledgeBase(tmp_path).load()
    assert build_snapshot_id(changed, root=tmp_path, rules_digest="r", config=config) != first


@pytest.mark.asyncio
async def test_lookup_reports_version_status_and_snapshot(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off")

    async with Client(server) as client:
        result = await client.call_tool("lookup_issue", {"query": DEMO_ALIAS})
        payload = result.structured_content

    assert payload["retrieval_version"] == RETRIEVAL_VERSION_V1
    assert payload["retrieval_status"] == STATUS_LEGACY
    assert payload["reason_codes"] == []
    assert len(payload["snapshot_id"]) == 64
    assert payload["hits"], "样例别名应当命中"
    hit = payload["hits"][0]
    assert hit["retrieval_version"] == RETRIEVAL_VERSION_V1
    assert hit["score_kind"] == SCORE_KIND_V1
    assert hit["match_reasons"] == []
    assert payload["documents"][0]["selection_reason"] == "legacy_unclassified"


@pytest.mark.asyncio
async def test_empty_lookup_still_reports_version_and_snapshot(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off")

    async with Client(server) as client:
        result = await client.call_tool("lookup_issue", {"query": "完全无关的量子烹饪"})
        payload = result.structured_content

    assert payload["hits"] == []
    assert payload["retrieval_version"] == RETRIEVAL_VERSION_V1
    assert payload["retrieval_status"] == STATUS_LEGACY
    assert len(payload["snapshot_id"]) == 64


@pytest.mark.asyncio
async def test_query_log_records_retrieval_version(tmp_path: Path, capsys) -> None:
    write_sample_entries(tmp_path)
    log_path = tmp_path / "queries.jsonl"
    server = create_knowledge_server(tmp_path, query_log_path=log_path)

    async with Client(server) as client:
        await client.call_tool("lookup_issue", {"query": DEMO_ALIAS})
        await client.call_tool("search_knowledge", {"query": "无命中查询示例"})

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    lookup_record = next(item for item in records if item["tool"] == "lookup_issue")
    assert lookup_record["retrieval_version"] == RETRIEVAL_VERSION_V1
    assert lookup_record["retrieval_status"] == STATUS_LEGACY
    assert len(lookup_record["snapshot_id"]) == 64
    search_record = next(item for item in records if item["tool"] == "search_knowledge")
    assert search_record["retrieval_version"] == RETRIEVAL_VERSION_V1

    # 混入一行无版本字段的历史日志:CLI 必须按 V1 解释且不崩溃(文档 10.3)。
    with log_path.open("a", encoding="utf-8") as stream:
        stream.write(
            json.dumps(
                {
                    "ts": "2026-09-01T00:00:00+00:00",
                    "tool": "lookup_issue",
                    "arguments": {"query": "历史未命中查询"},
                    "status": "ok",
                    "duration_ms": 1.0,
                    "hit_count": 0,
                }
            )
            + "\n"
        )
    assert query_log_main([str(log_path)]) == 0
    output = capsys.readouterr().out
    assert "历史未命中查询" in output
    assert "无法分类" not in output


# ---------- 阶段二:预览槽位分配(文档 8.2 / 14.6 预览行) ----------


def _hit(name: str, kind: KnowledgeKind, score: float, refs: list[str] | None = None) -> SearchHit:
    return SearchHit(
        name=name,
        kind=kind,
        summary=f"{name}摘要",
        score=score,
        authority=Authority.AUTO,
        applies_to=[End.HARMONY],
        end_match=True,
        version_match=True,
        matched_on="x",
        references=refs or [],
    )


def _entry(name: str, kind: KnowledgeKind, aliases: list[str] | None = None) -> KnowledgeEntry:
    return KnowledgeEntry(
        name=name,
        kind=kind,
        title=f"{name}标题",
        summary=f"{name}摘要",
        body="正文",
        applies_to=[End.HARMONY],
        authority=Authority.AUTO,
        aliases=aliases or [],
        source_path=f"{name}.md",
    )


def _resolver(entries: list[KnowledgeEntry]):
    by_name = {entry.name: entry for entry in entries}
    return by_name.get


def test_fact_in_remaining_hits_keeps_preview_slot_despite_crowded_references() -> None:
    """首候选八个引用、第二候选是目标事实:目标必须留在三篇预算内。"""
    crowded_refs = [f"ref-{index}" for index in range(8)]
    hits = [
        _hit("symptom-top", KnowledgeKind.SYMPTOM, 3.0, crowded_refs),
        _hit("target-fact", KnowledgeKind.PLATFORM_FACT, 2.7),
        _hit("symptom-third", KnowledgeKind.SYMPTOM, 2.6),
    ]
    entries = [_entry(ref, KnowledgeKind.PLATFORM_FACT) for ref in crowded_refs]
    selected = select_previews(hits, query="无关查询词", resolve=_resolver(entries))
    names = [name for name, _ in selected]
    assert names == ["symptom-top", "target-fact", "symptom-third"]
    assert dict(selected)["target-fact"] == DIRECT_HIT


def test_relevant_reference_takes_second_slot_when_no_fact_hit() -> None:
    """直接 hits 全是症状时,过门槛的引用事实占槽位二,标 relevant_reference。"""
    hits = [
        _hit("symptom-top", KnowledgeKind.SYMPTOM, 3.0, ["ref-relevant", "ref-other"]),
        _hit("symptom-next", KnowledgeKind.SYMPTOM, 2.8),
    ]
    entries = [
        _entry("ref-relevant", KnowledgeKind.PLATFORM_FACT, aliases=["蓝牙耳机接入"]),
        _entry("ref-other", KnowledgeKind.PLATFORM_FACT, aliases=["完全无关"]),
    ]
    selected = select_previews(hits, query="蓝牙耳机", resolve=_resolver(entries))
    assert selected[0] == ("symptom-top", DIRECT_HIT)
    assert selected[1] == ("ref-relevant", RELEVANT_REFERENCE)
    assert selected[2] == ("symptom-next", DIRECT_HIT)


def test_leftover_references_fill_as_reference_only() -> None:
    """无过门槛引用且直接 hits 不足三篇:hits[0] 的一跳引用补足,标 reference_only。"""
    hits = [_hit("symptom-top", KnowledgeKind.SYMPTOM, 3.0, ["ref-a", "ref-b"])]
    entries = [
        _entry("ref-a", KnowledgeKind.PLATFORM_FACT),
        _entry("ref-b", KnowledgeKind.PLATFORM_FACT),
    ]
    selected = select_previews(hits, query="完全无关", resolve=_resolver(entries))
    assert selected == [
        ("symptom-top", DIRECT_HIT),
        ("ref-a", REFERENCE_ONLY),
        ("ref-b", REFERENCE_ONLY),
    ]


def test_previews_dedupe_and_skip_unresolvable_or_symptom_references() -> None:
    hits = [
        _hit("symptom-top", KnowledgeKind.SYMPTOM, 3.0, ["symptom-next", "missing-ref"]),
        _hit("symptom-next", KnowledgeKind.SYMPTOM, 2.8),
    ]
    entries = [_entry("symptom-next", KnowledgeKind.SYMPTOM)]
    selected = select_previews(hits, query="无关", resolve=_resolver(entries))
    names = [name for name, _ in selected]
    assert names == ["symptom-top", "symptom-next"]  # 引用不重复占位,症状引用不进池
    assert select_previews([], query="q", resolve=_resolver(entries)) == []


# ---------- 阶段三:V2 引擎(文档 5-8 节、14.6 关键行) ----------

from harmony_knowledge_mcp.retrieval_v2 import (  # noqa: E402
    MAX_QUERY_CHARS,
    RETRIEVAL_VERSION_V2,
    SCORE_KIND_V2,
    STATUS_AMBIGUOUS,
    STATUS_INSUFFICIENT,
    STATUS_LEADS,
    STATUS_NO_MATCH,
    RetrievalEngine,
)


def _v2_entry(
    name: str,
    kind: KnowledgeKind,
    aliases: list[str],
    summary: str = "摘要",
    applies_to: list[End] | None = None,
) -> KnowledgeEntry:
    return KnowledgeEntry(
        name=name,
        kind=kind,
        title=f"{name}标题",
        summary=summary,
        body="正文",
        applies_to=applies_to or [End.HARMONY],
        authority=Authority.AUTO,
        aliases=aliases,
        source_path=f"{name}.md",
    )


@pytest.fixture
def engine() -> RetrievalEngine:
    return RetrievalEngine(
        [
            _v2_entry("sym-appraisal", KnowledgeKind.SYMPTOM, ["个人评价发不出去"]),
            _v2_entry("fact-appraisal", KnowledgeKind.PLATFORM_FACT, ["个人评价管理", "删除评价"]),
            _v2_entry("fact-contract", KnowledgeKind.PLATFORM_FACT, ["为什么没有电子合同"]),
            _v2_entry("sym-cloud", KnowledgeKind.SYMPTOM, ["没有分数", "白屏", "点了没反应"]),
            _v2_entry("fact-symbol", KnowledgeKind.PLATFORM_FACT, ["evaluationCheckView"]),
            _v2_entry(
                "fact-ios-only",
                KnowledgeKind.PLATFORM_FACT,
                ["个人评价管理"],
                applies_to=[End.IOS],
            ),
        ]
    )


def test_generic_state_alone_cannot_recall(engine: RetrievalEngine) -> None:
    """「白屏」「没有分数」是通用症状:不独立召回业务候选,状态为信息不足。"""
    for query in ("电脑开机后整个屏幕白屏", "高考查分页面没有分数", "点了没反应"):
        result = engine.lookup(query)
        assert result.hits == [], query
        assert result.status == STATUS_INSUFFICIENT


def test_latin_substring_never_matches_inside_identifier(engine: RetrievalEngine) -> None:
    """libnative.so 不得截取 native 撞词;无完整锚点即无匹配。"""
    result = engine.lookup("应用发生 SIGSEGV，堆栈在 libnative.so")
    assert result.hits == []
    assert result.status == STATUS_NO_MATCH


def test_full_symbol_recalls_via_exact_pathway(engine: RetrievalEngine) -> None:
    result = engine.lookup("evaluationCheckView 朗读评测 分数")
    assert result.hits[0].name == "fact-symbol"
    assert result.hits[0].match_reasons
    assert "exact-symbol" in result.hits[0].match_reasons


def test_generic_overlap_cannot_outrank_business_object(engine: RetrievalEngine) -> None:
    """「为什么没有」重合不再有资格;业务对象+动作的候选在前。"""
    result = engine.lookup("个人评价想撤回，为什么没有删除选项")
    names = [hit.name for hit in result.hits]
    assert "fact-contract" not in names  # 仅共享问句套话,不合格
    assert "sym-appraisal" in names
    assert result.status == STATUS_LEADS  # 识别了动作,不再是宽对象


def test_broad_object_only_marks_ambiguous(engine: RetrievalEngine) -> None:
    result = engine.lookup("个人评价")
    assert result.status == STATUS_AMBIGUOUS
    assert "broad-object-only" in result.reason_codes


def test_end_mismatch_demotes_but_keeps_hit(engine: RetrievalEngine) -> None:
    result = engine.lookup("个人评价管理", end=End.HARMONY)
    demoted = next(hit for hit in result.hits if hit.name == "fact-ios-only")
    assert demoted.end_match is False
    assert demoted.score < 0.55 * 0.55  # 原始覆盖分经 0.4 降权
    assert result.hits[-1] is demoted  # 降权使其排在匹配候选之后,但未被丢弃


def test_empty_and_overlong_queries(engine: RetrievalEngine) -> None:
    assert engine.lookup("   ").status == STATUS_INSUFFICIENT
    with pytest.raises(ValueError, match="上限"):
        engine.lookup("x" * (MAX_QUERY_CHARS + 1))


def test_ranking_is_deterministic(engine: RetrievalEngine) -> None:
    first = engine.lookup("个人评价为什么没有删除选项")
    second = engine.lookup("个人评价为什么没有删除选项")
    assert [hit.name for hit in first.hits] == [hit.name for hit in second.hits]


def test_v2_hit_metadata(engine: RetrievalEngine) -> None:
    result = engine.lookup("evaluationCheckView")
    hit = result.hits[0]
    assert hit.retrieval_version == RETRIEVAL_VERSION_V2
    assert hit.score_kind == SCORE_KIND_V2
    assert 0.0 <= hit.score <= 1.0


# ---------- 阶段三:server V2 模式集成(文档 9.1/9.2、14.6 MCP 行) ----------

from harmony_knowledge_mcp.retrieval_v2 import RETRIEVAL_VERSION_V2 as _V2  # noqa: E402


@pytest.mark.asyncio
async def test_v2_mode_lookup_reports_v2_metadata(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode="v2")

    async with Client(server) as client:
        result = await client.call_tool("lookup_issue", {"query": DEMO_PHRASE})
        payload = result.structured_content

    assert payload["retrieval_version"] == _V2
    assert payload["retrieval_status"] in (STATUS_LEADS, STATUS_AMBIGUOUS)
    assert payload["scope_used"] == "all"  # V2 全局竞争(文档 9.2)
    assert len(payload["snapshot_id"]) == 64
    assert payload["hits"], "样例查询含词表内对象,应召回"
    hit = payload["hits"][0]
    assert hit["retrieval_version"] == _V2
    assert hit["score_kind"] == SCORE_KIND_V2
    assert hit["match_reasons"]
    assert payload["documents"][0]["selection_reason"] in (
        DIRECT_HIT,
        RELEVANT_REFERENCE,
        REFERENCE_ONLY,
    )


@pytest.mark.asyncio
async def test_v2_mode_generic_query_reports_insufficient(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode="v2")

    async with Client(server) as client:
        result = await client.call_tool("lookup_issue", {"query": "点了没反应"})
        payload = result.structured_content

    assert payload["retrieval_status"] == STATUS_INSUFFICIENT
    assert payload["hits"] == []
    assert payload["documents"] == []


@pytest.mark.asyncio
async def test_v2_mode_search_respects_scope(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode="v2")

    async with Client(server) as client:
        fact_result = await client.call_tool(
            "search_knowledge", {"query": DEMO_PHRASE, "scope": "fact"}
        )
        symptom_result = await client.call_tool(
            "search_knowledge", {"query": DEMO_PHRASE, "scope": "symptom"}
        )

    fact_hits = fact_result.structured_content["result"]
    symptom_hits = symptom_result.structured_content["result"]
    assert all(hit["kind"] != "symptom" for hit in fact_hits)
    assert all(hit["kind"] == "symptom" for hit in symptom_hits)
    assert all(hit["retrieval_version"] == _V2 for hit in fact_hits + symptom_hits)


@pytest.mark.asyncio
async def test_v2_mode_query_log_records_v2_version(tmp_path: Path, capsys) -> None:
    write_sample_entries(tmp_path)
    log_path = tmp_path / "queries.jsonl"
    server = create_knowledge_server(tmp_path, query_log_path=log_path, retrieval_mode="v2")

    async with Client(server) as client:
        await client.call_tool("lookup_issue", {"query": DEMO_PHRASE})

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    record = records[0]
    assert record["retrieval_version"] == _V2
    assert record["score_kind"] == SCORE_KIND_V2
    assert record["retrieval_status"] in (STATUS_LEADS, STATUS_AMBIGUOUS)
    # V2 日志按 retrieval_status 分类(文档 10.3),CLI 必须能消费。
    assert query_log_main([str(log_path)]) == 0
    output = capsys.readouterr().out
    assert "无法分类" not in output
