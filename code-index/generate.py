"""Generate navigation-only code mappings from immutable source snapshots.

The input manifest is deliberately explicit: a directory is never guessed from a
version string. Every output path is discovered in that directory and carries its
source commit, so a missing snapshot produces coverage evidence instead of a fake
mapping.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EXTENSIONS = {".ets", ".ts", ".tsx", ".js", ".jsx", ".kt", ".kts", ".java", ".swift", ".m", ".mm", ".h", ".hpp", ".cpp", ".cc", ".gradle", ".json", ".json5", ".xml", ".yaml", ".yml", ".md", ".properties"}
SKIP = {".git", ".idea", ".hvigor", "build", "dist", "node_modules", "oh_modules", "Pods"}
DECLARATION = re.compile(r"\b(?:class|interface|struct|enum|object|function|func|def|const|let|var)\s+([A-Za-z_$][\w$]*)")
EXPORTED_DECLARATION = re.compile(r"\bexport\s+(?:default\s+)?(?:class|interface|struct|enum|object|function|func)\s+([A-Za-z_$][\w$]*)")


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", value.casefold())


def read_rules(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))["modules"]


def files(root: Path) -> list[Path]:
    found: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.casefold() not in EXTENSIONS:
            continue
        if any(part in SKIP for part in path.relative_to(root).parts):
            continue
        try:
            if path.stat().st_size > 512_000:
                continue
        except OSError:
            continue
        found.append(path)
    return found


def matches(rule: dict[str, Any], relative: str, content: str) -> list[str]:
    haystack = norm(relative + "\n" + content)
    terms = [*rule.get("keywords", []), *rule.get("path_hints", [])]
    return [term for term in terms if norm(term) and norm(term) in haystack]


def pointers(root: Path, paths: list[tuple[Path, list[str]]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for path, terms in paths[:12]:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        stem = norm(path.stem)
        declaration = next((match for match in EXPORTED_DECLARATION.finditer(text)
                            if norm(match.group(1)) == stem), None)
        declaration = declaration or next(EXPORTED_DECLARATION.finditer(text), None)
        declaration = declaration or next(DECLARATION.finditer(text), None)
        symbol = declaration.group(1) if declaration else path.stem
        line_start = text[: declaration.start()].count("\n") + 1 if declaration else 1
        output.append({
            "path": path.relative_to(root).as_posix(),
            "symbol": symbol,
            "line_start": line_start,
            "line_end": min(len(lines), line_start + 80),
            "terms": sorted(set(terms))[:12],
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path(".data/code-index/sources.json"))
    parser.add_argument("--rules", type=Path, default=Path("code-index/modules.json"))
    parser.add_argument("--output", type=Path, default=Path("code-index/index.jsonl"))
    parser.add_argument("--coverage", type=Path, default=Path("code-index/coverage.json"))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    rules = read_rules(args.rules)
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    records: list[dict[str, Any]] = []
    coverage: list[dict[str, Any]] = []
    for source in manifest.get("sources", []):
        root = Path(source["workspace"]).expanduser().resolve()
        base = {key: source.get(key) for key in ("platform", "product_line", "form_factor", "version", "build", "repository_id", "resolved_commit")}
        status = "ready" if root.is_dir() else "missing_snapshot"
        try:
            workspace_label = root.relative_to(Path.cwd()).as_posix()
        except ValueError:
            workspace_label = "external-snapshot"
        item: dict[str, Any] = {**base, "workspace": workspace_label, "status": status, "modules": []}
        if status != "ready":
            coverage.append(item)
            continue
        source_files = files(root)
        for rule in rules:
            hits: list[tuple[Path, list[str], int]] = []
            for path in source_files:
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                terms = matches(rule, path.relative_to(root).as_posix(), text)
                if terms:
                    path_text = norm(path.relative_to(root).as_posix())
                    score = sum(3 if norm(term) in path_text else 1 for term in terms)
                    hits.append((path, terms, score))
            if not hits:
                continue
            hits.sort(key=lambda item: (-item[2], item[0].as_posix()))
            pointers_value = pointers(root, [(path, terms) for path, terms, _ in hits])
            entry_id = hashlib.sha256(f"{rule['module_id']}|{base['platform']}|{base['product_line']}|{base['form_factor']}|{base['version']}|{base['repository_id']}|{base['resolved_commit']}".encode()).hexdigest()[:24]
            records.append({
                "schema_version": 1, "entry_id": entry_id, "record_type": "module",
                "title": rule["title"], "module_id": rule["module_id"], "aliases": rule.get("aliases", []),
                "keywords": rule.get("keywords", []), **base, "paths": pointers_value,
                "related_modules": [], "source": "generated", "generated_at": generated,
                "matched_file_count": len(hits), "mapping_method": "lexical-source-scan",
            })
            item["modules"].append({"module_id": rule["module_id"], "matched_file_count": len(hits)})
        coverage.append(item)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in records), encoding="utf-8")
    args.coverage.write_text(json.dumps({"generated_at": generated, "source_count": len(coverage), "entry_count": len(records), "sources": coverage}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"entries": len(records), "sources": len(coverage), "ready": sum(item["status"] == "ready" for item in coverage)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
