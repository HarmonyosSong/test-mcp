from __future__ import annotations

import sys
from pathlib import Path

from .loader import KnowledgeBase
from .server import KNOWLEDGE_ROOT_ENV, resolve_knowledge_root


def main(argv: list[str] | None = None) -> int:
    """校验知识库。有错误返回 1，仅有告警返回 0。"""
    arguments = sys.argv[1:] if argv is None else argv
    root = resolve_knowledge_root(Path(arguments[0]) if arguments else None)
    base = KnowledgeBase(root)
    errors, warnings = base.validate()

    print(f"知识库根目录：{root}")
    if not errors:
        entries = base.load()
        symptoms = sum(1 for entry in entries if entry.kind.value == "symptom")
        print(f"条目：{len(entries)}（现象 {symptoms}，事实 {len(entries) - symptoms}）")
        linked = {
            ref for entry in entries if entry.kind.value == "symptom" for ref in entry.references
        }
        orphans = sorted(
            entry.name
            for entry in entries
            if entry.kind.value != "symptom" and entry.name not in linked
        )
        print(f"现象未覆盖事实：{len(orphans)}")
        for name in orphans:
            print(f"警告：事实缺少现象入口：{name}")
    for warning in warnings:
        print(f"警告：{warning}")
    for error in errors:
        print(f"错误：{error}")
    if errors:
        print(f"校验失败：{len(errors)} 个错误。")
        return 1
    print("校验通过。")
    return 0


def _entrypoint() -> None:
    raise SystemExit(main())


if __name__ == "__main__":
    _entrypoint()


__all__ = ["KNOWLEDGE_ROOT_ENV", "main"]
