"""Content-level recall checks, separate from fixture-based retrieval algorithm tests."""

import json
from pathlib import Path

import pytest
from fastmcp import Client
from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.server import create_knowledge_server

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    json.loads(line)
    for line in (Path(__file__).parent / "datasets/knowledge_retrieval.jsonl")
    .read_text()
    .splitlines()
]


@pytest.mark.parametrize("item", CASES, ids=lambda item: item["query"])
async def test_curated_knowledge_recall(item) -> None:
    async with Client(create_knowledge_server(ROOT / "knowledge", query_log_path="off")) as client:
        result = await client.call_tool("lookup_issue", {"query": item["query"]})
    hits = result.structured_content["hits"]
    if item["expected"] is None:
        assert hits == []
    else:
        assert hits and hits[0]["name"] == item["expected"]


def test_extra_rewrites_are_not_copied_into_entry_aliases() -> None:
    base = KnowledgeBase(ROOT / "knowledge")
    base.load()
    terms = {term for entry in base.all() for term in entry.match_terms}
    assert all(item["query"] not in terms for item in CASES if item["split"] == "extra_rewrite")
