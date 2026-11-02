"""Task/media ranking contracts, independent of production entries and evaluation labels."""

from pathlib import Path

import pytest
from fastmcp import Client
from test_knowledge_base import FACT_FRONTMATTER, SYMPTOM_FRONTMATTER, entry_file
from test_retrieval_boundaries import fact
from test_retrieval_v2 import _hit

from harmony_knowledge_mcp import retrieval_rules as rules
from harmony_knowledge_mcp.preview_selection import DIRECT_HIT, RELEVANT_REFERENCE, select_previews
from harmony_knowledge_mcp.retrieval_v2 import RetrievalEngine
from harmony_knowledge_mcp.retriever import search
from harmony_knowledge_mcp.schemas import KnowledgeKind, SearchScope
from harmony_knowledge_mcp.server import create_knowledge_server


@pytest.mark.parametrize("query", ["错题录入", "上传错题", "错题本导入"])
def test_object_shorthand_retains_nested_input_action(query):
    features = rules.analyze_query(query)
    assert "error-book" in features.objects
    assert "transfer-in" in features.actions
    assert "transfer-out" not in features.actions


@pytest.mark.parametrize("query", ["PDF 上传失败", "照片导入", "课程图片", "PDF", "导出"])
def test_media_and_transfer_actions_alone_do_not_qualify(query):
    engine = RetrievalEngine([fact("book-media", "错题本上传图片及 PDF 导出")])
    assert engine.lookup(query).hits == []


@pytest.mark.parametrize("query", ["pdfWorker", "folder/pdf", "pdf_backup", "x.png"])
def test_media_does_not_match_inside_an_identifier_or_path(query):
    assert not rules.transfer_context(query)


@pytest.mark.parametrize("mode", ["legacy", "v2"])
@pytest.mark.parametrize("query", ["错题录入 PDF", "错题本导入 PDF"])
def test_input_task_beats_same_object_entry_despite_domain_preference(mode, query):
    entries = [
        fact("a-entry", "错题本入口展示").model_copy(update={"domains": ["preferred"]}),
        fact("b-export", "错题本导出 PDF"),
        fact("z-import", "错题本上传 PDF"),
    ]
    if mode == "legacy":
        hits = search(entries, query, scope=SearchScope.ALL, domains=["preferred"])
    else:
        hits = RetrievalEngine(entries).lookup(query, domains=["preferred"]).hits
    assert hits[0].name == "z-import"
    assert hits[0].domain_match is False
    assert {hit.name for hit in hits} == {entry.name for entry in entries}


def test_import_and_export_are_distinct_tasks_without_claiming_support():
    entries = [fact("import", "错题本不能上传 PDF"), fact("export", "错题本导出 PDF")]
    engine = RetrievalEngine(entries)
    assert engine.lookup("错题本导出 PDF").hits[0].name == "export"
    assert engine.lookup("错题本导入 PDF").hits[0].name == "import"
    # 此匹配仅找到谈论该操作的条目;不把否定句变成“支持上传”的事实。
    assert entries[0].summary == "错题本不能上传 PDF"


@pytest.mark.parametrize(
    "reference_score,expected,reason",
    [
        (0.8, "ref", RELEVANT_REFERENCE),
        (0.6, "direct", DIRECT_HIT),
        (0.4, "direct", DIRECT_HIT),
    ],
)
def test_fact_preview_competition_respects_relevance_and_direct_ties(
    reference_score, expected, reason
):
    reference = fact("ref", "候选事实")
    hits = [
        _hit("top", KnowledgeKind.SYMPTOM, 0.9, ["ref"]),
        _hit("other", KnowledgeKind.SYMPTOM, 0.7),
        _hit("direct", KnowledgeKind.PLATFORM_FACT, 0.6),
    ]
    selected = select_previews(
        hits,
        query="test",
        resolve=lambda name: reference if name == "ref" else None,
        score_reference=lambda entry: reference_score,
        threshold=0.35,
    )
    assert selected[1] == (expected, reason)
    assert len(selected) == len({name for name, _ in selected}) == 3


@pytest.mark.asyncio
async def test_ranked_reference_uses_same_platform_penalty_as_direct_hit(tmp_path: Path):
    entry_file(
        tmp_path,
        "symptoms",
        "top",
        SYMPTOM_FRONTMATTER.format(stem="top", symptom="错题本上传故障"),
        body="[[ref]]",
    )
    entry_file(
        tmp_path,
        "facts/account",
        "ref",
        FACT_FRONTMATTER.format(stem="ref", description="错题录入 PDF"),
        body="参考判据",
    )
    entry_file(
        tmp_path,
        "facts/account",
        "direct",
        FACT_FRONTMATTER.format(stem="direct", description="错题本上传说明").replace(
            "[harmony]", "[ios]"
        ),
    )
    # iOS: top/direct = 2.6; ref = 3.0 * 0.4。引用不能绕过端不匹配降权。
    server = create_knowledge_server(
        tmp_path, query_log_path="off", retrieval_mode="legacy", preview_strategy="ranked"
    )
    async with Client(server) as client:
        data = (
            await client.call_tool(
                "lookup_issue",
                {
                    "query": "错题录入 PDF",
                    "end": "ios",
                },
            )
        ).structured_content
    assert data["documents"][1]["name"] == "direct"


def test_transfer_rule_set_is_part_of_snapshot_digest(monkeypatch):
    before = rules.rules_digest()
    monkeypatch.setattr(rules, "TRANSFER_ACTIONS", frozenset({"transfer-in"}))
    assert rules.rules_digest() != before
