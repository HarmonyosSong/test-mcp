"""Read-only MCP regression for the new upload entries; no model or query-log writes."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from fastmcp import Client
from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.server import create_knowledge_server

ROOT = Path(__file__).resolve().parents[2]
CASES = Path(__file__).with_name("cases-error-book-2026-09-29.json")


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())
    entries = KnowledgeBase(ROOT / "knowledge").load()
    by_id = {entry.name: entry for entry in entries}
    inventory = {
        entry.source_path: hashlib.sha256(
            (ROOT / "knowledge" / entry.source_path).read_bytes()
        ).hexdigest()
        for entry in entries
    }
    result = {
        "dataset_sha256": hashlib.sha256(CASES.read_bytes()).hexdigest(),
        "description": cases["description"],
        "inventory": inventory,
        "modes": {},
    }
    for label, mode, strategy in (
        ("legacy", "legacy", "legacy"),
        ("legacy-ranked", "legacy", "ranked"),
        ("v2", "v2", "ranked"),
    ):
        rows = []
        server = create_knowledge_server(
            ROOT / "knowledge",
            query_log_path="off",
            retrieval_mode=mode,
            preview_strategy=strategy,
        )
        async with Client(server) as client:
            for split in ("positive", "negative", "ambiguous"):
                for index, (query, target_or_reason) in enumerate(cases[split]):
                    expected = [target_or_reason] if split == "positive" else []
                    assert set(expected) <= by_id.keys()
                    data = (
                        await client.call_tool(
                            "lookup_issue",
                            {
                                "query": query,
                                "end": "harmony",
                            },
                        )
                    ).structured_content
                    hits = [hit["name"] for hit in data["hits"]]
                    reached = set(hits) | {
                        ref for name in hits for ref in by_id[name].references
                    }
                    docs = [doc["name"] for doc in data["documents"]]
                    rows.append(
                        {
                            "id": f"{split}-{index}",
                            "split": split,
                            "query": query,
                            "expected": expected,
                            "reason": "" if expected else target_or_reason,
                            "hits": data["hits"],
                            "documents": data["documents"],
                            "status": data["retrieval_status"],
                            "reason_codes": data["reason_codes"],
                            "snapshot_id": data["snapshot_id"],
                            "direct1": bool(set(expected) & set(hits[:1])),
                            "direct3": bool(set(expected) & set(hits)),
                            "route3": bool(set(expected) & reached),
                            "preview": bool(set(expected) & set(docs)),
                        }
                    )
        positive = [row for row in rows if row["split"] == "positive"]
        summary = {
            "positive_n": len(positive),
            **{
                metric: sum(row[metric] for row in positive)
                for metric in ("direct1", "direct3", "route3", "preview")
            },
            "negative_n": len(cases["negative"]),
            "negative_with_hits": sum(
                bool(row["hits"]) for row in rows if row["split"] == "negative"
            ),
        }
        result["modes"][label] = {"rows": rows, "summary": summary}
    assert all(
        hashlib.sha256((ROOT / "knowledge" / path).read_bytes()).hexdigest() == digest
        for path, digest in inventory.items()
    ), "Knowledge changed during evaluation; rerun against a stable snapshot."
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {mode: value["summary"] for mode, value in result["modes"].items()},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
