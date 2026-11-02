"""消融 A-E(设计文档 14.2 变体、15 节阶段二/三)。

对 2026-09-28 审计的同一批查询:
- A = V1 hits + server 现行预览顺序(基线复刻)
- B = V1 hits + preview_selection 槽位分配(阶段二)
- C = V2 评分 + 症状直通(unified=False)+ 旧预览顺序
- D = C + 统一竞争(unified=True)
- E = D + 新预览槽位(注入 V2 引用相关性评分)
F(E + 审核新词表)属人工词表审核后的复跑,不在本脚本。

输出到 .data/knowledge-audit-ablation/ablation.json,并对照 14.5 发布门槛。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.preview_selection import select_previews
from harmony_knowledge_mcp.retrieval_v2 import RetrievalEngine
from harmony_knowledge_mcp.retriever import CONTAINMENT_SCORE, search
from harmony_knowledge_mcp.schemas import SearchScope
from run import build_cases

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
        dict.fromkeys(
            [hits[0].name, *hits[0].references, *(hit.name for hit in hits[1:])]
        )
    )
    return [name for name in selected[:limit] if name in by_id]


def main():
    base = KnowledgeBase(ROOT / "knowledge")
    entries = base.load()
    by_id = {entry.name: entry for entry in entries}
    engine = RetrievalEngine(entries)
    cases = build_cases(entries)

    rows = []
    for case in cases:
        query = case["query"]
        # A/B:V1 召回,两种预览。
        hits_v1 = v1_hits(entries, query)
        previews_a = variant_a(hits_v1, by_id)
        previews_b = [
            name for name, _ in select_previews(hits_v1, query=query, resolve=by_id.get)
        ]
        # C:V2 评分 + 症状直通(unified=False),预览沿用旧顺序。
        result_c = engine.lookup(query, unified=False)
        previews_c = variant_a(result_c.hits, by_id)
        # D:统一竞争(unified=True),预览沿用旧顺序。
        result_d = engine.lookup(query, unified=True)
        previews_d = variant_a(result_d.hits, by_id)
        # E:D + 新预览槽位,引用相关性由 V2 评分注入。
        result_e = result_d
        previews_e = [
            name
            for name, _ in select_previews(
                result_e.hits,
                query=query,
                resolve=by_id.get,
                score_reference=lambda entry, features=result_e.features: (
                    engine.reference_score(entry, features)
                ),
                threshold=engine.config.min_raw_score,
            )
        ]
        rows.append(
            {
                **case,
                "variants": {
                    "a": {
                        "hits": [hit.name for hit in hits_v1],
                        "previews": previews_a,
                    },
                    "b": {
                        "hits": [hit.name for hit in hits_v1],
                        "previews": previews_b,
                    },
                    "c": {
                        "hits": [hit.name for hit in result_c.hits],
                        "previews": previews_c,
                        "status": result_c.status,
                    },
                    "d": {
                        "hits": [hit.name for hit in result_d.hits],
                        "previews": previews_d,
                        "status": result_d.status,
                    },
                    "e": {
                        "hits": [hit.name for hit in result_e.hits],
                        "previews": previews_e,
                        "status": result_e.status,
                    },
                },
            }
        )

    def metrics(rows, variant):
        summary = {}
        for split in sorted({row["split"] for row in rows}):
            group = [row for row in rows if row["split"] == split]
            positive = [row for row in group if row["expected"]]
            negative = [row for row in group if not row["expected"]]

            def direct3(row):
                return bool(
                    set(row["expected"]) & set(row["variants"][variant]["hits"])
                )

            def route3(row):
                reached = set(row["variants"][variant]["hits"])
                for name in list(reached):
                    reached |= set(by_id[name].references)
                return bool(set(row["expected"]) & reached)

            def preview(row):
                return bool(
                    set(row["expected"]) & set(row["variants"][variant]["previews"])
                )

            summary[split] = {
                "positive_n": len(positive),
                "direct_hit3": sum(direct3(row) for row in positive),
                "route_hit3": sum(route3(row) for row in positive),
                "target_preview": sum(preview(row) for row in positive),
                "negative_with_hits": sum(
                    bool(row["variants"][variant]["hits"]) for row in negative
                ),
            }
        return summary

    summary = {variant: metrics(rows, variant) for variant in ("a", "b", "c", "d", "e")}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "ablation.json").write_text(
        json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2)
    )

    # 对照 14.5 发布门槛(E 变体为发布候选形态)。
    e = summary["e"]
    challenge = e.get("challenge_positive", {})
    gates = {
        "challenge 直接召回 direct_hit3 ≥ 25/38": challenge.get("direct_hit3", 0) >= 25,
        "challenge 引用可达 route_hit3 ≥ 30/38": challenge.get("route_hit3", 0) >= 30,
        "challenge 目标预览 ≥ 28/38": challenge.get("target_preview", 0) >= 28,
        "新负例误放 ≤ 4/16": e.get("challenge_negative", {}).get(
            "negative_with_hits", 99
        )
        <= 4,
        # build_cases 的旧负例 split 是 negative；existing-* 是 case ID，不能当 split。
        # 缺分组必须失败，避免 all([]) 把没有检查的门槛误报为通过。
        "旧负例误放 = 0": e.get("negative", {}).get("negative_with_hits") == 0,
        "pilot direct_hit3 ≥ 3/10": e.get("pilot_rewrite", {}).get("direct_hit3", 0)
        >= 3,
    }

    header = f"{'split':<22}" + "".join(f"{v:>28}" for v in ("A", "B", "C", "D", "E"))
    print(header)
    for split in sorted({row["split"] for row in rows}):
        line = f"{split:<22}"
        for variant in ("a", "b", "c", "d", "e"):
            stat = summary[variant].get(split, {})
            n = stat.get("positive_n", 0)
            cell = (
                f"d{stat.get('direct_hit3', 0)}/r{stat.get('route_hit3', 0)}"
                f"/p{stat.get('target_preview', 0)} of {n}"
            )
            if stat.get("negative_with_hits"):
                cell += f" 误放{stat['negative_with_hits']}"
            line += f"{cell:>28}"
        print(line)
    print("\n14.5 发布门槛(E 变体):")
    for gate, passed in gates.items():
        print(f"  {'✓' if passed else '✗'} {gate}")


if __name__ == "__main__":
    main()
