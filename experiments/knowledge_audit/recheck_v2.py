"""Read-only paired MCP evaluation of the current V2, including new stress cases.

Never changes knowledge, model configuration, retrieval rules, or production query logs.
Timings use alternating serial modes, five batches, with initialization measured separately.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import platform
import statistics
import subprocess
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

from fastmcp import Client
from harmony_knowledge_mcp import retrieval_rules
from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.preview_selection import select_previews
from harmony_knowledge_mcp.retrieval_v2 import RetrievalEngine, resolve_mode
from harmony_knowledge_mcp.schemas import SearchHit
from harmony_knowledge_mcp.server import create_knowledge_server

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(fraction * len(values)) - 1)]


def cases_from_file(path):
    content = json.loads(path.read_text())
    cases = []
    for split in ("positive", "negative", "contract_positive", "contract_negative"):
        for i, item in enumerate(content[split]):
            cases.append(
                {
                    "id": f"{split}-{i}",
                    "split": split,
                    "query": item[0],
                    "expected": [item[1]] if split.endswith("positive") else [],
                    "reason": item[2]
                    if len(item) == 3
                    else (item[1] if split.endswith("negative") else ""),
                }
            )
    return cases


def summarize(rows):
    result = {}
    for split in sorted({r["split"] for r in rows}):
        group = [r for r in rows if r["split"] == split]
        positives = [r for r in group if r["expected"]]
        negatives = [r for r in group if not r["expected"]]
        result[split] = {
            "n": len(group),
            "positive_n": len(positives),
            "negative_n": len(negatives),
            "direct1": sum(r["direct1"] for r in positives),
            "direct3": sum(r["direct3"] for r in positives),
            "route3": sum(r["route3"] for r in positives),
            "preview": sum(r["preview"] for r in positives),
            "negative_with_hits": sum(bool(r["hits"]) for r in negatives),
            "status_counts": dict(Counter(r["status"] for r in group)),
        }
    return result


async def measure_case(client, case, by_id, engine):
    started = perf_counter()
    data = (
        await client.call_tool("lookup_issue", {"query": case["query"]})
    ).structured_content
    elapsed = (perf_counter() - started) * 1000
    hits = [h["name"] for h in data["hits"]]
    docs = [d["name"] for d in data["documents"]]
    reached = set(hits) | {ref for name in hits for ref in by_id[name].references}
    targets = set(case["expected"])
    features = retrieval_rules.analyze_query(case["query"], canonical_ids=by_id)
    invalid_relevant = []
    for d in data["documents"]:
        if d["selection_reason"] == "relevant_reference":
            trace = engine.evaluate(by_id[d["name"]], features)
            if not trace.qualified:
                invalid_relevant.append(d["name"])
    return {
        **case,
        "hits": data["hits"],
        "documents": [
            {k: d[k] for k in ("name", "selection_reason", "truncated", "leads_only")}
            for d in data["documents"]
        ],
        "status": data["retrieval_status"],
        "reason_codes": data["reason_codes"],
        "snapshot_id": data["snapshot_id"],
        "preview_strategy": data["preview_strategy"],
        "scope": data["scope_used"],
        "direct1": bool(targets & set(hits[:1])),
        "direct3": bool(targets & set(hits)),
        "route3": bool(targets & reached),
        "preview": bool(targets & set(docs)),
        "elapsed_ms": elapsed,
        "payload_chars": len(json.dumps(data, ensure_ascii=False)),
        "query_objects": sorted(features.objects),
        "query_actions": sorted(features.actions),
        "unqualified_relevant_references": invalid_relevant,
        "budget_ok": len(hits) <= 3
        and len(docs) <= 3
        and sum(len(d["body"]) for d in data["documents"]) <= 4500
        and all(d["leads_only"] for d in data["documents"]),
    }


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path, default=ROOT / ".data/knowledge-v2-followup/paired"
    )
    parser.add_argument("--include-ranked-preview", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    case_path = HERE / "cases-v2-followup-2026-09-28.json"
    cases = cases_from_file(case_path)
    base = KnowledgeBase(ROOT / "knowledge")
    entries = base.load()
    by_id = {e.name: e for e in entries}
    for c in cases:
        assert set(c["expected"]) <= by_id.keys(), c
    engine = RetrievalEngine(entries)
    digest_before = retrieval_rules.rules_digest()
    inventory = {
        e.source_path: sha(ROOT / "knowledge" / e.source_path) for e in entries
    }
    result = {
        "generated_at": datetime.now(UTC).isoformat(),
        "commit": (
            await asyncio.to_thread(
                subprocess.check_output,
                ["git", "rev-parse", "HEAD"],
                cwd=ROOT,
                text=True,
            )
        ).strip(),
        "environment": {
            "system": platform.platform(),
            "python": platform.python_version(),
        },
        "default_mode": resolve_mode().value,
        "dataset_sha256": sha(case_path),
        "rules_digest": digest_before,
        "source_hashes": {
            p.name: sha(p)
            for p in sorted(
                (ROOT / "mcp_server/src/harmony_knowledge_mcp").glob("*.py")
            )
        },
        "inventory": inventory,
        "modes": {},
    }
    # Baseline-first correctness run; timings below alternate the order independently.
    for mode in ("legacy", "v2"):
        server = create_knowledge_server(
            ROOT / "knowledge", query_log_path="off", retrieval_mode=mode
        )
        async with Client(server) as client:
            rows = [await measure_case(client, c, by_id, engine) for c in cases]
        result["modes"][mode] = {"rows": rows, "summary": summarize(rows)}

    if args.include_ranked_preview:
        server = create_knowledge_server(
            ROOT / "knowledge",
            query_log_path="off",
            retrieval_mode="legacy",
            preview_strategy="ranked",
        )
        async with Client(server) as client:
            rows = [await measure_case(client, c, by_id, engine) for c in cases]
        assert all(
            a["hits"] == b["hits"]
            for a, b in zip(result["modes"]["legacy"]["rows"], rows, strict=True)
        )
        result["modes"]["legacy-ranked"] = {"rows": rows, "summary": summarize(rows)}

    # Isolate preview selection from candidate changes using measured V1 hits.
    preview_rows = []
    for row in result["modes"]["legacy"]["rows"]:
        selected = select_previews(
            [SearchHit.model_validate(hit) for hit in row["hits"]],
            query=row["query"],
            resolve=by_id.get,
        )
        preview_rows.append(
            {
                "id": row["id"],
                "split": row["split"],
                "expected": row["expected"],
                "preview_ids": [name for name, _ in selected],
                "target_in_preview": bool(
                    set(row["expected"]) & {name for name, _ in selected}
                ),
            }
        )
    result["preview_only_ablation"] = {
        "method": "Offline selection only, using actual legacy MCP hits; no separate latency claim.",
        "rows": preview_rows,
        "positive_target_preview": sum(
            r["target_in_preview"] for r in preview_rows if r["split"] == "positive"
        ),
    }

    qualification_probes = []
    for query in (
        "家长注册培优账号时，手机号应该按八位还是十一位校验",
        "香港家长注册培优账号时，手机号应该按八位还是十一位校验",
    ):
        features = retrieval_rules.analyze_query(query)
        trace = engine.evaluate(by_id["login-registration-basics"], features)
        qualification_probes.append(
            {
                "query": query,
                "objects": sorted(features.objects),
                "qualified": trace.qualified,
                "object_coverage": trace.object_coverage,
                "raw_score": trace.raw_score,
                "hits": [h.name for h in engine.lookup(query).hits],
            }
        )
    result["qualification_probes"] = qualification_probes

    performance = {
        mode: {"initialization_ms": [], "batches": []} for mode in ("legacy", "v2")
    }
    perf_cases = [c for c in cases if c["split"] in ("positive", "negative")]
    for batch in range(5):
        for mode in ("legacy", "v2") if batch % 2 == 0 else ("v2", "legacy"):
            t = perf_counter()
            server = create_knowledge_server(
                ROOT / "knowledge", query_log_path="off", retrieval_mode=mode
            )
            performance[mode]["initialization_ms"].append((perf_counter() - t) * 1000)
            timings, payloads = [], []
            async with Client(server) as client:
                await client.call_tool("lookup_issue", {"query": "错题本进不去"})
                for c in perf_cases:
                    t = perf_counter()
                    data = (
                        await client.call_tool("lookup_issue", {"query": c["query"]})
                    ).structured_content
                    timings.append((perf_counter() - t) * 1000)
                    payloads.append(len(json.dumps(data, ensure_ascii=False)))
            performance[mode]["batches"].append(
                {"timings_ms": timings, "payload_chars": payloads}
            )
    for value in performance.values():
        durations = [t for b in value["batches"] for t in b["timings_ms"]]
        payloads = [t for b in value["batches"] for t in b["payload_chars"]]
        value["summary"] = {
            "requests": len(durations),
            "p50_ms": statistics.median(durations),
            "p95_ms": percentile(durations, 0.95),
            "initialization_p50_ms": statistics.median(value["initialization_ms"]),
            "payload_chars_p50": statistics.median(payloads),
            "payload_chars_p95": percentile(payloads, 0.95),
        }
    result["performance"] = performance
    # Pure in-process mutation probe: restore global state in finally, never edit source or files.
    old_facets = retrieval_rules.UNIT_FACETS
    old_features = retrieval_rules.analyze_query("八英里").facets
    try:
        retrieval_rules.UNIT_FACETS = (
            *old_facets,
            (("八英里",), ("distance", "8mile")),
        )
        changed_features = retrieval_rules.analyze_query("八英里").facets
        changed_digest = retrieval_rules.rules_digest()
        result["digest_probe"] = {
            "facets_changed": old_features != changed_features,
            "digest_changed": digest_before != changed_digest,
            "meaning": "Facet-rule mutation should change rules digest; isolated in-memory probe only.",
        }
    finally:
        retrieval_rules.UNIT_FACETS = old_facets
    assert inventory == {
        e.source_path: sha(ROOT / "knowledge" / e.source_path) for e in entries
    }
    assert digest_before == retrieval_rules.rules_digest()
    (args.out / "results.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2)
    )
    print(
        json.dumps(
            {
                "summary": {mode: r["summary"] for mode, r in result["modes"].items()},
                "performance": {mode: r["summary"] for mode, r in performance.items()},
                "digest_probe": result["digest_probe"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
