#!/usr/bin/env python3
"""真实对照跑批(方案 §8):固定模型/commit/知识库/预算,6 场景 × N 次全链路实测。

用法: python3 experiments/runtime_audit/run_real_control.py [--repeat 3]
输出: experiments/runtime_audit/results-real-control-<date>.json + 终端汇总表。

固定条件记录在结果头部:模型(当前 API 配置)、xesapp 分支、知识库 git commit、
工具预算默认值。质量结论(事实正确/未越权/合理追问/引用可追溯)需人工评审,
本脚本只做结构计量与 quality_marks 关键词辅助信号。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

BASE = "http://127.0.0.1:8000"
ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((Path(__file__).parent / "cases-real-control-2026-09-29.json").read_text())


def req(method: str, path: str, payload: dict | None = None, stream: bool = False):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        BASE + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    return urllib.request.urlopen(request, timeout=900 if stream else 30)


def fixed_conditions() -> dict:
    meta = json.load(req("GET", "/api/meta"))
    knowledge_commit = subprocess.run(
        ["git", "-C", str(ROOT), "log", "--oneline", "-1", "--", "knowledge/"],
        capture_output=True,
        text=True,
    ).stdout.strip()
    return {
        "model": meta.get("model"),
        "repo": {"name": "xesapp", "branch": "releaseV/20260921"},
        "knowledge_head": knowledge_commit,
        "tool_budget_defaults": {"failure_limit": 10, "call_limit": 30, "no_progress_limit": 4},
    }


def run_case(case: dict) -> dict:
    conversation = json.load(req("POST", "/api/conversations", {}))
    cid = conversation["id"]
    turns = []
    for content in case["messages"]:
        started = time.time()
        resp = req("POST", f"/api/conversations/{cid}/messages", {"content": content}, stream=True)
        for line in resp:
            if line.startswith(b"data:"):
                pass  # 消费 SSE 至结束
        turns.append({"content_head": content[:40], "elapsed_s": round(time.time() - started, 1)})
    detail = json.load(req("GET", f"/api/conversations/{cid}"))
    assistant = detail["messages"][-1]
    steps = assistant.get("steps", [])
    report = assistant.get("report") or {}
    text = assistant.get("content") or ""
    expect = case["expect"]
    marks = {
        mark: (mark in text or mark in json.dumps(report, ensure_ascii=False))
        for mark in expect.get("quality_marks", [])
    }
    verdict_ok = expect.get("verdict") is None or report.get("verdict") in expect["verdict"]
    submit_expected = expect.get("should_submit")
    submitted = report.get("verdict") is not None
    return {
        "case_id": case["id"],
        "conversation_id": cid,
        "status": assistant.get("status"),
        "steps": len(steps),
        "failed_calls": sum(1 for step in steps if step.get("status") == "failed"),
        "tools": dict(Counter(step["tool"] for step in steps)),
        "input_tokens": assistant.get("input_tokens"),
        "output_tokens": assistant.get("output_tokens"),
        "verdict": report.get("verdict"),
        "confidence": report.get("confidence"),
        "evidence_count": len(report.get("evidence", [])),
        "missing_count": len(report.get("missing_information", [])),
        "quality_marks": marks,
        "verdict_ok": verdict_ok,
        "submit_ok": submit_expected is None or submitted == submit_expected,
        "turns": turns,
        "text": text,
        "report": report,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--only", type=str, default=None, help="只跑指定 case id(逗号分隔)")
    args = parser.parse_args()

    conditions = fixed_conditions()
    print("固定条件:", json.dumps(conditions, ensure_ascii=False))
    cases = CASES
    if args.only:
        wanted = set(args.only.split(","))
        cases = [case for case in CASES if case["id"] in wanted]
    runs = []
    for case in cases:
        for iteration in range(1, args.repeat + 1):
            print(f"[{case['id']} #{iteration}] 运行中...", flush=True)
            try:
                row = run_case(case)
            except Exception as exc:  # 记录所有成功与失败,不让单轮中断批次
                row = {"case_id": case["id"], "error": f"{type(exc).__name__}: {exc}"}
            row["iteration"] = iteration
            runs.append(row)
            print(
                f"  -> {row.get('status', 'ERROR')} | 步数 {row.get('steps', '-')}"
                f" | 失败 {row.get('failed_calls', '-')}"
                f" | verdict {row.get('verdict', '-')}"
                f" | token {row.get('input_tokens', '-')}",
                flush=True,
            )

    output = {
        "date": str(date.today()),
        "conditions": conditions,
        "repeat": args.repeat,
        "runs": runs,
    }
    target = Path(__file__).parent / (
        f"results-real-control-{date.today()}.json"
        if not args.only
        else f"results-real-control-{date.today()}-{'-'.join(sorted(set(args.only.split(','))))}.json"
    )
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(f"\n结果已写入 {target}")

    # 汇总表:每场景 步数均值/失败合计/verdict 合规率/提交合规率
    print(f"\n{'场景':<28} {'轮次':>3} {'均步数':>6} {'失败调用':>6} {'verdict合规':>8} {'提交合规':>6} {'均输入token':>10}")
    for case in cases:
        rows = [r for r in runs if r["case_id"] == case["id"] and "error" not in r]
        if not rows:
            print(f"{case['id']:<28} {0:>3}  全部失败")
            continue
        steps_avg = sum(r["steps"] for r in rows) / len(rows)
        failed = sum(r["failed_calls"] for r in rows)
        verdict_rate = sum(1 for r in rows if r["verdict_ok"]) / len(rows)
        submit_rate = sum(1 for r in rows if r["submit_ok"]) / len(rows)
        tokens_avg = sum(r["input_tokens"] or 0 for r in rows) / len(rows)
        print(
            f"{case['id']:<28} {len(rows):>3} {steps_avg:>6.1f} {failed:>6}"
            f" {verdict_rate:>8.0%} {submit_rate:>6.0%} {tokens_avg:>10.0f}"
        )


if __name__ == "__main__":
    sys.exit(main())
