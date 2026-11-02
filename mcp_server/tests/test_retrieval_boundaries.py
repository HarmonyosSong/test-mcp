"""Boundary, qualifier and independently selectable preview regressions.

Fixtures describe the matching contract; no dependence on production aliases or case IDs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastmcp import Client
from test_knowledge_base import DEMO_PHRASE, write_sample_entries

from harmony_knowledge_mcp import retrieval_rules as rules
from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.retrieval_v2 import RetrievalConfigError, RetrievalEngine
from harmony_knowledge_mcp.schemas import Authority, End, KnowledgeEntry, KnowledgeKind, SearchScope
from harmony_knowledge_mcp.server import create_knowledge_server


def fact(name: str, *terms: str) -> KnowledgeEntry:
    return KnowledgeEntry(
        name=name,
        title=terms[0],
        summary=" / ".join(terms),
        aliases=list(terms),
        body="## 判据\n核实当前源码。",
        kind=KnowledgeKind.PLATFORM_FACT,
        applies_to=[End.HARMONY],
        authority=Authority.AUTO,
        domains=["account"],
        source_path=f"facts/account/{name}.md",
    )


@pytest.mark.parametrize(
    "query",
    [
        "合，同",
        "发，票",
        "课 堂 笔 记",
        "foo/xnote",
        "foo_xnote",
        "xnoteBackupTask",
        "xnotebook",
        "evaluationCheckViewExtra",
    ],
)
def test_separators_and_identifier_parts_do_not_create_matches(query):
    engine = RetrievalEngine(
        [
            fact("contract", "合同"),
            fact("invoice", "发票"),
            fact("notes", "课堂笔记"),
            fact("authorization", "XNote应用授权"),
            fact("symbol", "evaluationCheckView"),
        ]
    )
    assert engine.lookup(query).hits == []


def test_field_separator_never_joins_two_terms():
    assert "invoice" not in rules.analyze_entry_text("发\n票")
    assert "authorization" in rules.analyze_query("XNote：无法授权").objects
    assert "authorization" in rules.analyze_query("请检查 XNote。").objects


@pytest.mark.parametrize("query", ["香港明天天气", "附近药店", "桌面弹窗广告", "腾讯会议晨会"])
def test_qualifier_without_a_shared_business_context_cannot_recall(query):
    engine = RetrievalEngine(
        [
            fact("registration", "注册地区香港"),
            fact("nearby", "附近教学点的课程"),
            fact("popup", "班级过期的弹窗"),
            fact("meeting", "课程使用腾讯会议"),
        ]
    )
    assert engine.lookup(query).hits == []


@pytest.mark.parametrize(
    "query,target",
    [
        ("注册地区选择香港", "registration"),
        ("选课时附近筛选不显示", "nearby"),
        ("班级的弹窗不显示", "popup"),
        ("课程为什么使用腾讯会议", "meeting"),
    ],
)
def test_same_qualifier_with_shared_business_context_is_a_lead(query, target):
    engine = RetrievalEngine(
        [
            fact("registration", "注册地区香港"),
            fact("nearby", "附近教学点的课程"),
            fact("popup", "班级过期的弹窗"),
            fact("meeting", "课程使用腾讯会议"),
        ]
    )
    result = engine.lookup(query, domains=["wrong-domain"])
    assert target in [hit.name for hit in result.hits]
    assert all(hit.domain_match is False for hit in result.hits)
    assert result.status == "ambiguous"
    assert "contextual-qualifier-only" in result.reason_codes


def test_registered_mixed_language_phrase_preserves_existing_spaced_alias():
    engine = RetrievalEngine([fact("bridge", "H5 调用原生没反应")])
    assert engine.lookup("调起原生录音").hits[0].name == "bridge"
    assert engine.lookup("h5调用原生").hits[0].name == "bridge"
    assert engine.lookup("h5 调用原生").hits[0].name == "bridge"
    assert engine.lookup("myh5 调用原生").hits == []


def test_geographic_qualifier_does_not_dilute_phone_object():
    engine = RetrievalEngine([fact("registration-phone", "手机号注册校验")])
    plain = engine.lookup("家长注册手机号校验")
    specific = engine.lookup("香港家长注册手机号校验")
    assert specific.hits[0].name == plain.hits[0].name == "registration-phone"
    assert specific.hits[0].score >= plain.hits[0].score


def test_speaker_identity_does_not_rank_an_unrelated_cart_fact_higher():
    symptom = fact("cart-failure", "购物车结算失败").model_copy(
        update={"kind": KnowledgeKind.SYMPTOM}
    )
    engine = RetrievalEngine([symptom, fact("purchase", "家长在购物车购买课程")])
    assert engine.lookup("家长反馈购物车结算失败").hits[0].name == "cart-failure"


def test_canonical_ids_are_exact_anchors_in_both_apis():
    engine = RetrievalEngine([fact("opaque-fact-id", "无词表锚点")])
    assert engine.lookup("请读取 opaque-fact-id").hits[0].name == "opaque-fact-id"
    assert engine.search("opaque-fact-id", scope=SearchScope.FACT)[0].name == "opaque-fact-id"
    assert engine.lookup("prefix_opaque-fact-id").hits == []
    assert engine.lookup("opaque-fact-id-extra").hits == []


def test_facets_and_context_rules_participate_in_snapshot_digest(monkeypatch):
    initial = rules.rules_digest()
    monkeypatch.setattr(
        rules, "UNIT_FACETS", (*rules.UNIT_FACETS, (("八英里",), ("distance", "8mile")))
    )
    assert ("distance", "8mile") in rules.analyze_query("八英里").facets
    changed = rules.rules_digest()
    assert changed != initial
    monkeypatch.setattr(rules, "CONTEXT_CUES", (*rules.CONTEXT_CUES, ("test", ("测试场景",))))
    assert rules.rules_digest() != changed


def test_reference_score_cannot_bypass_anchor_qualification(monkeypatch):
    entry = fact("target", "合同取消")
    engine = RetrievalEngine([entry])
    features = rules.analyze_query("合同发票取消")
    # Two objects of different information weight: target remains just below O qualification,
    # while matching the action lifts raw_score past the numeric threshold.
    monkeypatch.setattr(engine, "_idf", {"contract": 2.4, "invoice": 2.6, "cancel": 1.0})
    trace = engine.evaluate(entry, features)
    assert trace.raw_score >= engine.config.min_raw_score and not trace.qualified
    assert engine.reference_score(entry, features) == 0


@pytest.mark.asyncio
async def test_ranked_preview_switch_preserves_legacy_hits_and_is_logged(tmp_path: Path):
    write_sample_entries(tmp_path)
    responses = {}
    for strategy in ("legacy", "ranked"):
        log_path = tmp_path / f"{strategy}.jsonl"
        server = create_knowledge_server(
            tmp_path,
            query_log_path=log_path,
            retrieval_mode="legacy",
            preview_strategy=strategy,
        )
        async with Client(server) as client:
            response = (
                await client.call_tool("lookup_issue", {"query": DEMO_PHRASE})
            ).structured_content
        responses[strategy] = response
        assert response["preview_strategy"] == strategy
        assert json.loads(log_path.read_text())["preview_strategy"] == strategy
        assert all(d["leads_only"] for d in response["documents"])
        assert sum(len(d["body"]) for d in response["documents"]) <= 4500
    assert responses["legacy"]["hits"] == responses["ranked"]["hits"]
    assert responses["legacy"]["snapshot_id"] != responses["ranked"]["snapshot_id"]


def test_bad_preview_policy_fails_at_startup(tmp_path: Path):
    with pytest.raises(RetrievalConfigError, match="preview_strategy"):
        create_knowledge_server(tmp_path, preview_strategy="anything")


def test_entry_lookup_does_not_change_metadata(tmp_path: Path):
    write_sample_entries(tmp_path)
    entries = KnowledgeBase(tmp_path).load()
    before = [entry.model_dump() for entry in entries]
    engine = RetrievalEngine(entries)
    engine.lookup("个人评价", domains=["wrong"], end=End.IOS)
    assert before == [entry.model_dump() for entry in entries]
