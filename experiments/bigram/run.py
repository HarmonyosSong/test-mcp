"""34 条冻结查询对照:生产 baseline vs 纯 bigram vs bigram+concepts。

复用 .data/qmd-pilot/fixtures.json(语料 sha256 已冻结),两段式回退逻辑复刻
server.lookup_issue:symptom 域 top1 达阈值直通,否则全局重搜;阈值同时充当候选过滤。
一次评分后对每组阈值重放决策;另输出正/负样本分数分离度。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bigram_index import build_index, score_entries  # noqa: E402
from harmony_knowledge_mcp.concepts import concept_score  # noqa: E402
from harmony_knowledge_mcp.loader import KnowledgeBase  # noqa: E402
from harmony_knowledge_mcp.schemas import KnowledgeKind  # noqa: E402

FIXTURES = ROOT / ".data/qmd-pilot/fixtures.json"
OUT = ROOT / ".data/bigram-pilot"

# concept 命中的 additive 加成:concept_score 满分 2.6 线性映射到 [0, 8]。
# 8 低于一个 alias 精确命中(24+),与一个中等字面命中相当;候选系数,随结果校准。
CONCEPT_BONUS = 8.0
THRESHOLDS = [0, 6, 8, 10, 12, 15, 18, 22, 25]
SPLITS = ("regression", "extra_rewrite", "pilot_rewrite", "negative")


def load_corpus_inventory() -> dict:
    return {
        str(p.relative_to(ROOT / "knowledge")): hashlib.sha256(p.read_bytes()).hexdigest()
        for pattern in ("facts/*/*.md", "symptoms/*.md")
        for p in sorted((ROOT / "knowledge").glob(pattern))
    }


def with_concepts(scores, query, entries):
    """bigram 分数上叠加 concept 加成;concept 满强度(2.6)映射 +CONCEPT_BONUS。"""
    seen = {idx: (score, matched_on) for idx, score, matched_on in scores}
    merged = []
    for idx, entry in enumerate(entries):
        concept_value, concept_term = concept_score(query, entry.match_terms)
        base_score, base_matched = seen.get(idx, (0.0, ""))
        if concept_value > 0:
            bonus = CONCEPT_BONUS * concept_value / 2.6
            merged.append((idx, base_score + bonus, base_matched or concept_term))
        elif base_score > 0:
            merged.append((idx, base_score, base_matched))
    merged.sort(key=lambda item: (-item[1], entries[item[0]].name))
    return merged


def two_stage(sym_scores, all_scores, threshold):
    """复刻 lookup_issue:symptom 域 top1 达阈值直通,否则全局重搜。"""
    symptom_hits = [hit for hit in sym_scores if hit[1] >= threshold]
    if symptom_hits:
        return "symptom", symptom_hits
    return "all", [hit for hit in all_scores if hit[1] >= threshold]


def recall(baseline_hits, expected, k):
    names = [hit["name"] for hit in baseline_hits[:k]]
    return any(name in names for name in expected)


def main():
    fixtures = json.loads(FIXTURES.read_text())
    cases = fixtures["cases"]
    baseline = {row["id"]: row["hits"] for row in fixtures["baseline"]}
    inventory = load_corpus_inventory()
    if inventory != fixtures["corpus"]:
        print("警告:语料与 fixtures 冻结时不一致,结果不与 QMD 实验严格可比", file=sys.stderr)

    base = KnowledgeBase(ROOT / "knowledge")
    entries = base.load()
    index = build_index(entries)
    symptom_idx = {i for i, e in enumerate(index.entries) if e.kind is KnowledgeKind.SYMPTOM}

    rows = []
    for case in cases:
        started = perf_counter()
        all_scores = score_entries(index, case["query"])
        strict_scores = score_entries(index, case["query"], strict=True)
        elapsed_ms = (perf_counter() - started) * 1000
        concept_scores = with_concepts(all_scores, case["query"], index.entries)
        row = {
            "id": case["id"],
            "split": case["split"],
            "query": case["query"],
            "expected": case["expected"],
            "elapsed_ms": round(elapsed_ms, 3),
            "replay": {
                "bigram": {
                    "symptom": [h for h in all_scores if h[0] in symptom_idx],
                    "all": all_scores,
                },
                "strict": {
                    "symptom": [h for h in strict_scores if h[0] in symptom_idx],
                    "all": strict_scores,
                },
                "concept": {
                    "symptom": [h for h in concept_scores if h[0] in symptom_idx],
                    "all": concept_scores,
                },
            },
        }
        rows.append(row)

    def names_of(hits, k):
        return [(index.entries[i].name, round(s, 3), m) for i, s, m in hits[:k]]

    # 阈值扫描:对每组阈值重放两段式决策
    table = {}
    for mode in ("bigram", "strict", "concept"):
        for threshold in THRESHOLDS:
            stats = {split: {"n": 0, "hit1": 0, "hit3": 0, "fp": 0} for split in SPLITS}
            misses = []
            for row in rows:
                split = row["split"]
                scope, hits = two_stage(
                    row["replay"][mode]["symptom"], row["replay"][mode]["all"], threshold
                )
                names = [index.entries[i].name for i, _, _ in hits[:3]]
                if split == "negative":
                    stats[split]["n"] += 1
                    stats[split]["fp"] += bool(hits)
                    continue
                stats[split]["n"] += 1
                hit1 = any(name in names[:1] for name in row["expected"])
                hit3 = any(name in names[:3] for name in row["expected"])
                stats[split]["hit1"] += hit1
                stats[split]["hit3"] += hit3
                if not hit3:
                    misses.append({
                        "id": row["id"], "query": row["query"], "expected": row["expected"],
                        "got": names_of(hits, 3), "scope": scope,
                    })
            table[f"{mode}@{threshold}"] = {"stats": stats, "misses": misses}

    # 分离度:正样本期望条目最高分 vs 负样本 top1(纯 bigram,全局域,无阈值)
    pos_scores, neg_scores = [], []
    for row in rows:
        all_full = row["replay"]["bigram"]["all"]
        if row["split"] == "negative":
            if all_full:
                neg_scores.append((row["id"], round(all_full[0][1], 3)))
        else:
            by_name = {index.entries[i].name: s for i, s, _ in all_full}
            best = max((by_name.get(name, 0.0) for name in row["expected"]), default=0.0)
            pos_scores.append((row["id"], round(best, 3)))

    # baseline 汇总(生产现状:子串 + concepts)
    base_stats = {split: {"n": 0, "hit1": 0, "hit3": 0, "fp": 0} for split in SPLITS}
    for case in cases:
        hits = baseline[case["id"]]
        split = case["split"]
        if split == "negative":
            base_stats[split]["n"] += 1
            base_stats[split]["fp"] += bool(hits)
        else:
            base_stats[split]["n"] += 1
            base_stats[split]["hit1"] += recall(hits, case["expected"], 1)
            base_stats[split]["hit3"] += recall(hits, case["expected"], 3)

    latencies = sorted(row["elapsed_ms"] for row in rows)
    summary = {
        "corpus_digest": hashlib.sha256(
            json.dumps(inventory, sort_keys=True).encode()
        ).hexdigest(),
        "entries": len(entries),
        "cases": len(cases),
        "latency_ms": {"p50": round(latencies[len(latencies) // 2], 3), "max": round(latencies[-1], 3)},
        "baseline": base_stats,
        "separation": {"positive": sorted(pos_scores, key=lambda x: x[1]),
                       "negative": sorted(neg_scores, key=lambda x: -x[1])},
        "thresholds": {key: value["stats"] for key, value in table.items()},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    rows_for_dump = [
        {
            **{k: row[k] for k in ("id", "split", "query", "expected", "elapsed_ms")},
            **{
                mode: {scope: names_of(row["replay"][mode][scope], 3) for scope in ("symptom", "all")}
                for mode in ("bigram", "strict", "concept")
            },
        }
        for row in rows
    ]
    (OUT / "results.json").write_text(json.dumps(
        {"summary": summary, "rows": rows_for_dump,
         "misses": {key: value["misses"] for key, value in table.items()}},
        ensure_ascii=False, indent=2))

    def fmt(stats):
        parts = []
        for split in SPLITS:
            s = stats[split]
            if split == "negative":
                parts.append(f"neg误放{s['fp']}/{s['n']}")
            else:
                parts.append(f"{split.split('_')[0]} {s['hit1']}/{s['n']}@1 {s['hit3']}/{s['n']}@3")
        return " | ".join(parts)

    print(f"语料 {len(entries)} 条,查询 {len(cases)} 条,bigram p50 {summary['latency_ms']['p50']}ms")
    print(f"[baseline 生产现状] {fmt(base_stats)}")
    for key, value in table.items():
        print(f"[{key}] {fmt(value['stats'])}")
    print("\n分离度(纯 bigram 全局域):正样本期望条目分数 vs 负样本 top1 分数")
    print("  正样本最低 5:", summary["separation"]["positive"][:5])
    print("  负样本:", summary["separation"]["negative"])
    best_key = f"bigram@{THRESHOLDS[0]}"
    print(f"\n{best_key} 之上漏网明细见 .data/bigram-pilot/results.json 的 misses")


if __name__ == "__main__":
    main()
