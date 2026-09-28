"""Read-only audit through the production knowledge MCP; no knowledge mutation or telemetry writes."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import statistics
import subprocess
from collections import Counter
from pathlib import Path
from time import perf_counter

from fastmcp import Client
from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.retriever import normalize, search
from harmony_knowledge_mcp.schemas import SearchScope
from harmony_knowledge_mcp.server import create_knowledge_server

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".data/knowledge-audit-2026-09-28"


def build_cases(entries):
    cases = []
    for i, line in enumerate(
        (ROOT / "agent/evals/datasets/knowledge_retrieval.jsonl")
        .read_text()
        .splitlines()
    ):
        item = json.loads(line)
        cases.append(
            {
                "id": f"existing-{i}",
                "split": item["split"],
                "query": item["query"],
                "expected": [item["expected"]] if item["expected"] else [],
            }
        )
    spec = importlib.util.spec_from_file_location(
        "qmd_prepare", ROOT / "experiments/qmd/prepare.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for i, (q, expected) in enumerate(module.EXTRA):
        cases.append(
            {
                "id": f"pilot-{i}",
                "split": "pilot_rewrite",
                "query": q,
                "expected": expected,
            }
        )
    new = json.loads(Path(__file__).with_name("cases-2026-09-28.json").read_text())
    terms = {normalize(t) for e in entries for t in e.match_terms}
    for i, (q, expected) in enumerate(new["positive"]):
        assert normalize(q) not in terms, f"challenge copied from match terms: {q}"
        cases.append(
            {
                "id": f"challenge-{i}",
                "split": "challenge_positive",
                "query": q,
                "expected": [expected],
            }
        )
    for i, (q, reason) in enumerate(new["negative"]):
        cases.append(
            {
                "id": f"negative-{i}",
                "split": "challenge_negative",
                "query": q,
                "expected": [],
                "reason": reason,
            }
        )
    for entry in entries:
        if entry.kind.value != "symptom":
            cases.append(
                {
                    "id": f"anchor-{entry.name}",
                    "split": "fact_anchor",
                    "query": entry.aliases[0] if entry.aliases else entry.title,
                    "expected": [entry.name],
                }
            )
    return cases


def summarize(rows):
    result = {}
    for group in sorted({r["split"] for r in rows}):
        selected = [r for r in rows if r["split"] == group]
        positive = [r for r in selected if r["expected"]]
        negative = [r for r in selected if not r["expected"]]
        times = sorted(r["elapsed_ms"] for r in selected)
        result[group] = {
            "n": len(selected),
            "positive_n": len(positive),
            "negative_n": len(negative),
            "direct_hit1": sum(r["direct_hit1"] for r in positive),
            "direct_hit3": sum(r["direct_hit3"] for r in positive),
            "route_hit3": sum(r["route_hit3"] for r in positive),
            "target_in_preview": sum(r["target_in_preview"] for r in positive),
            "target_criteria_in_preview": sum(
                r["target_criteria_in_preview"] for r in positive
            ),
            "misses": [r["id"] for r in positive if not r["route_hit3"]],
            "negative_with_hits": sum(bool(r["hits"]) for r in negative),
            "p50_ms": statistics.median(times),
            "p95_ms": times[min(len(times) - 1, int(0.95 * len(times)))],
            "payload_chars_p50": statistics.median(
                r["payload_chars"] for r in selected
            ),
        }
    return result


async def main():
    # 显式 mode 与独立输出目录(设计文档第 16 节):消融各变体写入各自目录,
    # 不覆盖 2026-09-28 的 V1 基线归档;v2/shadow 在引擎交付前启动即报配置错误。
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        default="legacy",
        choices=["legacy", "shadow", "v2"],
        help="检索模式,默认 legacy(基线)",
    )
    parser.add_argument(
        "--out",
        default=str(OUT),
        help="输出目录,默认 .data/knowledge-audit-2026-09-28",
    )
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = KnowledgeBase(ROOT / "knowledge")
    entries = base.load()
    by_id = {e.name: e for e in entries}
    symptoms = [e for e in entries if e.kind.value == "symptom"]
    facts = [e for e in entries if e.kind.value != "symptom"]
    errors, warnings = base.validate()
    cases = build_cases(entries)
    linked = {ref for e in symptoms for ref in e.references}
    audit = {
        "commit": (
            await asyncio.to_thread(
                subprocess.check_output,
                ["git", "rev-parse", "HEAD"],
                cwd=ROOT,
                text=True,
            )
        ).strip(),
        "date": "2026-09-28",
        "mode": args.mode,
        "errors": errors,
        "warnings": warnings,
        "inventory": {
            e.source_path: hashlib.sha256(
                (ROOT / "knowledge" / e.source_path).read_bytes()
            ).hexdigest()
            for e in entries
        },
        "counts": {
            "entries": len(entries),
            "facts": len(facts),
            "symptoms": len(symptoms),
            "orphan_facts": len({e.name for e in facts} - linked),
            "authority": dict(Counter(e.authority.value for e in entries)),
            "fact_authority": dict(Counter(e.authority.value for e in facts)),
            "verified_facts": sum(e.verified_at is not None for e in facts),
            "verified_symptoms": sum(e.verified_at is not None for e in symptoms),
            "explicit_version_facts": sum(bool(e.applicable_versions) for e in facts),
            "fact_domains": dict(
                Counter(Path(e.source_path).parent.name for e in facts)
            ),
            "facts_with_criteria_heading": sum("## 判据" in e.body for e in facts),
            "facts_with_exception_heading": sum(
                "## 例外" in e.body or "## 注意" in e.body for e in facts
            ),
        },
        "rows": [],
    }
    async with Client(
        create_knowledge_server(
            ROOT / "knowledge", query_log_path="off", retrieval_mode=args.mode
        )
    ) as client:
        for item in cases:
            t = perf_counter()
            data = (
                await client.call_tool("lookup_issue", {"query": item["query"]})
            ).structured_content
            duration = round((perf_counter() - t) * 1000, 3)
            expected = set(item["expected"])
            assert expected <= by_id.keys(), (
                f"Unknown expected IDs: {expected - by_id.keys()}"
            )
            ids = [h["name"] for h in data["hits"]]
            reached = set(ids) | {ref for name in ids for ref in by_id[name].references}
            previews = [d["name"] for d in data["documents"]]
            # Access through a broad symptom's reference is route reachability, NOT direct precision.
            row = {
                **item,
                "elapsed_ms": duration,
                "scope": data["scope_used"],
                "payload_chars": len(json.dumps(data, ensure_ascii=False)),
                "hits": data["hits"],
                "preview_names": previews,
                "truncated_previews": [
                    d["name"] for d in data["documents"] if d["truncated"]
                ],
                "preview_has_question_section": any(
                    "区分它们需要什么" in d["body"] for d in data["documents"]
                ),
                "direct_hit1": bool(expected & set(ids[:1])),
                "direct_hit3": bool(expected & set(ids)),
                "route_hit3": bool(expected & reached),
                "target_in_preview": bool(expected & set(previews)),
                "target_criteria_in_preview": any(
                    d["name"] in expected and "## 判据" in d["body"]
                    for d in data["documents"]
                ),
                "fact_only_hits": [
                    h.name
                    for h in search(entries, item["query"], scope=SearchScope.FACT)
                ],
                "all_hits": [
                    h.name
                    for h in search(entries, item["query"], scope=SearchScope.ALL)
                ],
            }
            audit["rows"].append(row)
        # Test actual discrimination question visibility for every symptom's own primary phrase.
        audit["symptom_probes"] = []
        for entry in symptoms:
            data = (
                await client.call_tool("lookup_issue", {"query": entry.summary})
            ).structured_content
            audit["symptom_probes"].append(
                {
                    "name": entry.name,
                    "top": data["hits"][0]["name"] if data["hits"] else None,
                    "question_in_preview": any(
                        "区分它们需要什么" in d["body"] for d in data["documents"]
                    ),
                    "own_question_in_preview": any(
                        d["name"] == entry.name and "区分它们需要什么" in d["body"]
                        for d in data["documents"]
                    ),
                    "refs": len(entry.references),
                    "refs_in_preview": len(
                        set(entry.references) & {d["name"] for d in data["documents"]}
                    ),
                }
            )
    audit["summary"] = summarize(audit["rows"])
    (out_dir / "results.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2))
    print(
        json.dumps(
            {"counts": audit["counts"], "summary": audit["summary"]},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
