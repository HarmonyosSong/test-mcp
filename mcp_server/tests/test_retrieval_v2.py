"""V2 检索框架阶段一合同测试:模式解析、配置校验、快照标识、版本化输出与日志。

对应 docs/knowledge-retrieval-v2-design.md 第 4/9/10/11 节;V2 引擎主体属阶段三,
本文件只锁定双模式框架的既有承诺。样例条目自包含,不依赖 knowledge/ 当前内容。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastmcp import Client
from test_knowledge_base import DEMO_ALIAS, write_sample_entries

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
from harmony_knowledge_mcp.server import create_knowledge_server


def test_resolve_mode_defaults_to_legacy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE", raising=False)
    assert resolve_mode() == "legacy"
    assert resolve_mode(None) == "legacy"
    assert resolve_mode("") == "legacy"


def test_resolve_mode_rejects_unknown_value() -> None:
    with pytest.raises(RetrievalConfigError, match="非法"):
        resolve_mode("turbo")


def test_non_legacy_modes_fail_fast_until_engine_lands(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    for mode in ("v2", "shadow"):
        with pytest.raises(RetrievalConfigError, match="阶段三"):
            create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode=mode)


def test_config_rejects_out_of_range_and_unbalanced_weights() -> None:
    with pytest.raises(RetrievalConfigError, match="\\[0,1\\]"):
        RetrievalConfig(min_raw_score=1.5)
    with pytest.raises(RetrievalConfigError, match="之和必须为 1"):
        RetrievalConfig(weight_object=0.9)


def test_snapshot_id_is_stable_order_independent_and_content_sensitive(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    from harmony_knowledge_mcp.loader import KnowledgeBase

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
