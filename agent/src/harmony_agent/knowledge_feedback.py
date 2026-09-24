"""Durable, human-reviewed diagnosis -> knowledge proposals. No automatic authority promotion."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import yaml
from harmony_knowledge_mcp.loader import KnowledgeBase
from harmony_knowledge_mcp.retriever import search
from harmony_knowledge_mcp.schemas import SearchScope

from .domain import Conversation


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def capture(conversation: Conversation, message_id: str, directory: Path) -> Path:
    index = next(i for i, m in enumerate(conversation.messages) if m.id == message_id)
    message = conversation.messages[index]
    if message.role != "assistant" or message.status == "streaming":
        raise ValueError("只能归档已结束的 assistant 轮次")
    path = directory / f"{conversation.id}-{message.id}.json"
    if path.exists():
        return path  # Idempotent; never erase an existing human review.
    write_json(
        path,
        {
            "id": path.stem,
            "conversation_id": conversation.id,
            "message_id": message.id,
            "captured_at": datetime.now(UTC).isoformat(),
            "input": conversation.messages[index - 1].content if index else "",
            "repository_id": conversation.repository_id,
            "commit": conversation.resolved_commit,
            "message": message.model_dump(mode="json"),
            "evidence_state": conversation.evidence_state,
            "review": None,
            "knowledge_entry": None,
        },
    )
    return path


def review_case(
    path: Path, *, outcome: str, root_cause: str, reviewer: str, evidence_ids: list[str]
) -> dict:
    case = json.loads(path.read_text())
    if outcome not in {"confirmed", "rejected", "uncertain"}:
        raise ValueError("invalid outcome")
    if not reviewer.strip() or not root_cause.strip():
        raise ValueError("必须填写复核人和结论理由")
    report = case["message"].get("report") or {}
    observed = {e["id"] for e in report.get("evidence", []) if e["kind"] in {"source", "log"}}
    if not set(evidence_ids) <= observed:
        raise ValueError("证据 ID 必须来自已校验报告的源码或日志观测")
    if outcome == "confirmed" and not evidence_ids:
        raise ValueError("确认根因必须关联实际观测证据")
    case["review"] = {
        "outcome": outcome,
        "root_cause": root_cause,
        "reviewer": reviewer,
        "evidence_ids": evidence_ids,
        "reviewed_at": datetime.now(UTC).isoformat(),
    }
    write_json(path, case)
    return case


def draft_case(path: Path, root: Path, name: str, domain: str) -> Path:
    if not all(re.fullmatch(r"[a-z0-9][a-z0-9-]*", value) for value in (name, domain)):
        raise ValueError("name/domain 必须为 kebab-case")
    case = json.loads(path.read_text())
    if not case.get("review") or case["review"]["outcome"] != "confirmed":
        raise ValueError("先复核并确认根因，再提炼知识")
    base = KnowledgeBase(root)
    base.load()
    existing = base.get(name)
    if existing and existing.kind.value == "symptom":
        raise ValueError("不能用事实草稿覆盖现象 ID")
    candidates = search(base.all(), case["input"], scope=SearchScope.ALL)
    if existing:
        body = (root / existing.source_path).read_text(encoding="utf-8")
    else:
        meta = {
            "name": name,
            "kind": "mapping",
            "domains": [domain],
            "applies_to": ["harmony"],
            "authority": "auto",
            "updated_at": datetime.now(UTC).date(),
            "description": "待提炼：填写可复用的现象与判据",
            "aliases": [],
        }
        body = "---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) + "---\n"
        body += (
            "\n# 待提炼\n\n## 事实与适用范围\n\n待提炼\n\n## 判据\n\n待提炼\n\n## 例外\n\n待提炼\n"
        )
    draft = path.with_suffix(".md")
    if draft.exists():
        raise ValueError("草稿已存在，保留人工编辑，请直接编辑现有草稿")
    draft.write_text(body, encoding="utf-8")
    case["proposal"] = {
        "name": name,
        "domain": domain,
        "draft": str(draft),
        "existing_entry": existing.name if existing else None,
        "base_sha256": hashlib.sha256(body.encode()).hexdigest() if existing else None,
        "similar_entries": [hit.name for hit in candidates],
    }
    write_json(path, case)
    return draft


def apply_draft(path: Path, root: Path) -> Path:
    """Validate an edited proposal in isolation, then atomically update its canonical entry."""
    case = json.loads(path.read_text())
    if not case.get("review") or case["review"]["outcome"] != "confirmed":
        raise ValueError("先确认案例")
    proposal = case["proposal"]
    draft = Path(proposal["draft"]).read_text(encoding="utf-8")
    if "待提炼" in draft:
        raise ValueError("请完成草稿中的待提炼内容和适用范围")
    base = KnowledgeBase(root)
    base.load()
    existing = base.get(proposal["name"])
    if existing:
        target = root / existing.source_path
        if hashlib.sha256(target.read_bytes()).hexdigest() != proposal["base_sha256"]:
            raise ValueError("规范条目已变化，请合并新内容后重新生成草稿")
    else:
        target = root / "facts" / proposal["domain"] / (proposal["name"] + ".md")
    relative = target.relative_to(root)
    with tempfile.TemporaryDirectory(prefix="knowledge-proposal-") as temporary:
        staged = Path(temporary) / "knowledge"
        shutil.copytree(root, staged)
        staged_target = staged / relative
        staged_target.parent.mkdir(parents=True, exist_ok=True)
        staged_target.write_text(draft, encoding="utf-8")
        checked = KnowledgeBase(staged)
        checked.load()
        if checked.get(proposal["name"]) is None:
            raise ValueError("草稿必须保持规范 ID")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_target = target.with_suffix(".tmp")
    temporary_target.write_text(draft, encoding="utf-8")
    temporary_target.replace(target)
    link_entry(path, root, proposal["name"])
    return target


def link_entry(path: Path, root: Path, name: str) -> None:
    """Close the loop only after the reviewed content has actually landed in the canonical KB."""
    case = json.loads(path.read_text())
    if not case.get("review") or case["review"]["outcome"] != "confirmed":
        raise ValueError("只有确认案例可标记已提炼")
    base = KnowledgeBase(root)
    base.load()  # Reject invalid content/references, including duplicate IDs.
    entry = base.get(name)
    if entry is None or entry.kind.value == "symptom":
        raise ValueError("须关联已入库的规范事实 ID")
    case["knowledge_entry"] = name
    case["linked_at"] = datetime.now(UTC).isoformat()
    write_json(path, case)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(".data/knowledge-cases"))
    parser.add_argument("--knowledge", type=Path, default=Path("knowledge"))
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capture")
    cap.add_argument("--conversations", type=Path, default=Path(".data/conversations.json"))
    cap.add_argument("--conversation", required=True)
    cap.add_argument("--message", required=True)
    rev = sub.add_parser("review")
    rev.add_argument("case", type=Path)
    rev.add_argument("--outcome", choices=["confirmed", "rejected", "uncertain"], required=True)
    rev.add_argument("--root-cause", required=True)
    rev.add_argument("--reviewer", required=True)
    rev.add_argument("--evidence-id", action="append", default=[])
    draft = sub.add_parser("draft")
    draft.add_argument("case", type=Path)
    draft.add_argument("--name", required=True)
    draft.add_argument("--domain", required=True)
    apply = sub.add_parser("apply")
    apply.add_argument("case", type=Path)
    link = sub.add_parser("link")
    link.add_argument("case", type=Path)
    link.add_argument("--name", required=True)
    sub.add_parser("list")
    args = parser.parse_args()
    if args.command == "capture":
        values = json.loads(args.conversations.read_text())
        conversation = next(
            Conversation.model_validate(c) for c in values if c["id"] == args.conversation
        )
        print(capture(conversation, args.message, args.directory))
    elif args.command == "review":
        review_case(
            args.case,
            outcome=args.outcome,
            root_cause=args.root_cause,
            reviewer=args.reviewer,
            evidence_ids=args.evidence_id,
        )
    elif args.command == "draft":
        print(draft_case(args.case, args.knowledge, args.name, args.domain))
    elif args.command == "apply":
        print(apply_draft(args.case, args.knowledge))
    elif args.command == "link":
        link_entry(args.case, args.knowledge, args.name)
    else:
        for path in sorted(args.directory.glob("*.json")):
            case = json.loads(path.read_text())
            print(
                case["id"],
                (case.get("review") or {}).get("outcome", "pending"),
                case.get("knowledge_entry") or "未提炼",
            )


if __name__ == "__main__":
    main()
