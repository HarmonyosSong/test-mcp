"""消融 B:仅替换预览选择,保持 V1 hits 不变(设计文档 14.2 变体 A/B、15 节阶段二)。

对 2026-09-28 审计的同一批查询,变体 A 复刻 server 现行「top1 → 其全部引用 → 其余
hits」预览顺序,变体 B 用 preview_selection 的槽位分配;比较目标正文可见性。
本阶段收益只归因于正文选择,不归因于召回提升。输出到
.data/knowledge-audit-ablation/preview-ab.json。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from run import build_cases  # noqa: E402
from harmony_knowledge_mcp.loader import KnowledgeBase  # noqa: E402
from harmony_knowledge_mcp.preview_selection import select_previews  # noqa: E402
from harmony_knowledge_mcp.retriever import CONTAINMENT_SCORE, search  # noqa: E402
from harmony_knowledge_mcp.schemas import SearchScope  # noqa: E402

OUT = ROOT / ".data/knowledge-audit-ablation"


def v1_hits(entries, query):
    """复刻 server.lookup_issue 的两段式(无 end/version 参数时其条件恒真)。"""
    hits = search(entries, query, scope=SearchScope.SYMPTOM)
    if not hits or hits[0].score < CONTAINMENT_SCORE:
        hits = search(entries, query, scope=SearchScope.ALL)
    return hits


def variant_a(hits, by_id, limit=3):
    """server 现行顺序:top1 → top1 的全部直接引用 → 其余 hits,去重截三。"""
    if not hits:
        return []
    selected = list(
        dict.fromkeys([hits[0].name, *hits[0].references, *(hit.name for hit in hits[1:])])
    )
    return [name for name in selected[:limit] if name in by_id]


def main():
    base = KnowledgeBase(ROOT / "knowledge")
    entries = base.load()
    by_id = {entry.name: entry for entry in entries}
    cases = build_cases(entries)

    rows = []
    for case in cases:
        hits = v1_hits(entries, case["query"])
        previews_a = variant_a(hits, by_id)
        previews_b = [name for name, _ in select_previews(hits, query=case["query"], resolve=by_id.get)]
        expected = set(case["expected"])
        rows.append({
            **case,
            "previews_a": previews_a,
            "previews_b": previews_b,
            "target_a": bool(expected & set(previews_a)),
            "target_b": bool(expected & set(previews_b)),
            "criteria_a": any("## 判据" in by_id[name].body for name in previews_a if name in expected),
            "criteria_b": any("## 判据" in by_id[name].body for name in previews_b if name in expected),
        })

    summary = {}
    for split in sorted({row["split"] for row in rows}):
        group = [row for row in rows if row["split"] == split]
        positive = [row for row in group if row["expected"]]
        summary[split] = {
            "positive_n": len(positive),
            "target_preview_a": sum(row["target_a"] for row in positive),
            "target_preview_b": sum(row["target_b"] for row in positive),
            "criteria_preview_a": sum(row["criteria_a"] for row in positive),
            "criteria_preview_b": sum(row["criteria_b"] for row in positive),
        }
    changed = [
        {
            "id": row["id"],
            "split": row["split"],
            "query": row["query"],
            "a": row["previews_a"],
            "b": row["previews_b"],
            "delta": ("+目标" if row["target_b"] and not row["target_a"]
                      else "-目标" if row["target_a"] and not row["target_b"] else "无目标变化"),
        }
        for row in rows
        if row["previews_a"] != row["previews_b"]
    ]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "preview-ab.json").write_text(json.dumps(
        {"summary": summary, "changed": changed, "rows": rows}, ensure_ascii=False, indent=2
    ))
    for split, stat in summary.items():
        if stat["positive_n"] == 0:
            continue
        print(f"{split}(n={stat['positive_n']}): "
              f"目标预览 A {stat['target_preview_a']} -> B {stat['target_preview_b']} | "
              f"判据可见 A {stat['criteria_preview_a']} -> B {stat['criteria_preview_b']}")
    print(f"\n预览变化 {len(changed)} 条:")
    for item in changed:
        print(f"  [{item['delta']}] {item['id']} {item['query'][:30]!r} A={item['a']} B={item['b']}")


if __name__ == "__main__":
    main()
