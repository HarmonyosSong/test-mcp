"""Run a fixed live chat suite and summarize quality alongside cost (including failures)."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from .agents import Completed, Failed, HarmonyChatAgent, ToolFinished
from .config import Settings
from .domain import ChatMessage, Conversation
from .knowledge_feedback import capture, write_json
from .repositories import ConversationRepository
from .runtimes.model_gateway import ModelGateway
from .skill_runtime import SkillRegistry

COSTS = (
    "input_tokens",
    "output_tokens",
    "model_requests",
    "calls",
    "executed",
    "reused",
    "result_chars",
    "elapsed_ms",
)


def summarize(rows: list[dict]) -> dict:
    """Unknown quality/cost stays unknown. Failed rows are never discarded."""
    result: dict = {"turns": len(rows), "failed": sum(r.get("status") == "failed" for r in rows)}
    for key in ("correct_location", "unsupported_conclusion", "appropriate_clarification"):
        labels = [r[key] for r in rows if isinstance(r.get(key), bool)]
        result[key] = {
            "assessed": len(labels),
            "unassessed": len(rows) - len(labels),
            "rate": sum(labels) / len(labels) if labels else None,
        }
    result["cost"] = {}
    for key in COSTS:
        values = [r.get(key) for r in rows]
        known = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        result["cost"][key] = {
            "known_total": sum(known),
            "unknown_turns": len(rows) - len(known),
            "total": sum(known) if len(known) == len(rows) else None,
        }
    return result


def compare(current: dict, baseline: dict) -> dict:
    for key in ("model", "dataset_sha256"):
        if current.get(key) != baseline.get(key):
            raise ValueError(f"不能比较不同 {key} 的评估")
    if [r["case_id"] for r in current["rows"]] != [r["case_id"] for r in baseline["rows"]]:
        raise ValueError("比较必须包含相同案例和轮次，包括失败轮次")
    delta = {}
    for key, value in current["summary"]["cost"].items():
        old = baseline["summary"]["cost"][key]["total"]
        delta[key] = (
            value["total"] - old if old is not None and value["total"] is not None else None
        )
    return {
        "cost_delta": delta,
        "baseline_quality": baseline["summary"],
        "current_quality": current["summary"],
    }


async def run_live(dataset: Path, output: Path, timeout: int) -> dict:
    settings = Settings()
    gateway = ModelGateway(settings)
    if not gateway.enabled:
        raise ValueError("未配置真实模型；本次评估失败，不跳过或记为通过")
    registry = SkillRegistry(settings.skills_dir)
    registry.load()
    records = ConversationRepository(output.parent / (output.stem + "-conversations.json"))
    rows = []
    raw = dataset.read_bytes()
    artifact = {
        "model": gateway.status().model_dump(mode="json", exclude={"base_url"}),
        "dataset_sha256": hashlib.sha256(raw).hexdigest(),
        "started_at": datetime.now(UTC).isoformat(),
        "rows": rows,
    }
    try:
        with tempfile.TemporaryDirectory(prefix="harmony-live-") as work:
            workspace = Path(work)
            for item in [json.loads(line) for line in raw.decode().splitlines() if line.strip()]:
                case_workspace = workspace / item["id"]
                case_workspace.mkdir()
                for name, content in item.get("files", {}).items():
                    target = (case_workspace / name).resolve()
                    if not target.is_relative_to(case_workspace.resolve()):
                        raise ValueError("fixture path escapes workspace")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content)
                conversation = Conversation(
                    workspace_path=str(case_workspace) if item.get("files") else None,
                    title=item["id"],
                )
                agent = HarmonyChatAgent(registry, gateway)
                for turn_index, prompt in enumerate(item["prompts"]):
                    conversation.messages.append(ChatMessage(role="user", content=prompt))
                    message = ChatMessage(role="assistant", status="streaming")
                    conversation.messages.append(message)
                    row = {"case_id": f"{item['id']}:{turn_index}", "status": "failed"}
                    final = None
                    try:
                        async with asyncio.timeout(timeout):
                            async for event in agent.stream_turn(conversation, prompt):
                                if isinstance(event, ToolFinished):
                                    message.steps.append(event.event)
                                if isinstance(event, (Completed, Failed)):
                                    final = event
                        if isinstance(final, Completed):
                            message.content = final.text
                            message.report = final.report
                            message.status = "completed"
                            message.input_tokens = final.input_tokens
                            message.output_tokens = final.output_tokens
                            conversation.messages_state = final.messages_state
                            row["status"] = "completed"
                        else:
                            message.status = "failed"
                            message.error = (
                                final.error
                                if isinstance(final, Failed)
                                else "missing terminal event"
                            )
                    except Exception as exc:
                        message.status = "failed"
                        message.error = f"{type(exc).__name__}: {exc}"
                    if final:
                        message.tool_usage = final.tool_usage
                        conversation.evidence_state = final.evidence_state
                    if message.status == "failed":
                        conversation.retain_failed_turn_input(message.id)
                    row.update(message.tool_usage)
                    row.update(
                        input_tokens=message.input_tokens,
                        output_tokens=message.output_tokens,
                        error=message.error,
                        conversation_id=conversation.id,
                        message_id=message.id,
                    )
                    expected = item.get("expected", [])[turn_index]
                    report = message.report
                    # Explicit fixture assertions, not a claim of human causal adjudication.
                    if "location" in expected:
                        row["correct_location"] = bool(
                            report
                            and report.verdict.value in {"located", "probable"}
                            and expected["location"] in (report.likely_location or "")
                        )
                    if expected.get("clarification_terms"):
                        row["appropriate_clarification"] = bool(
                            row["status"] == "completed"
                            and any(
                                term in message.content for term in expected["clarification_terms"]
                            )
                        )
                    row["report_submitted"] = report is not None
                    row["expected_verdict_pass"] = (
                        report is not None
                        and report.verdict.value
                        in (
                            expected["verdict"]
                            if isinstance(expected["verdict"], list)
                            else [expected["verdict"]]
                        )
                        if expected.get("verdict")
                        else None
                    )
                    # Free-text conclusions still need review, including turns without reports.
                    row["unsupported_conclusion"] = None
                    rows.append(row)
                    await records.save(conversation)
                    capture(conversation, message.id, output.parent / (output.stem + "-cases"))
                    artifact["summary"] = summarize(rows)
                    write_json(output, artifact)  # Persist each turn, including failures.
    finally:
        await gateway.close()
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", type=Path, help="固定 JSONL 场景；未配置模型时返回失败")
    parser.add_argument("--input", type=Path, help="已有评估产物，可人工补充三项质量布尔标签")
    parser.add_argument("--output", type=Path, default=Path(".data/evals/latest.json"))
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    if bool(args.live) == bool(args.input):
        parser.error("指定 --live 或 --input 之一")
    artifact = (
        asyncio.run(run_live(args.live, args.output, args.timeout))
        if args.live
        else json.loads(args.input.read_text())
    )
    artifact["summary"] = summarize(artifact["rows"])
    if args.baseline:
        artifact["comparison"] = compare(artifact, json.loads(args.baseline.read_text()))
    write_json(args.output, artifact)
    print(json.dumps(artifact["summary"], ensure_ascii=False, indent=2))
    if any(
        r["status"] == "failed"
        or r.get("correct_location") is False
        or r.get("appropriate_clarification") is False
        or r.get("expected_verdict_pass") is False
        for r in artifact["rows"]
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
