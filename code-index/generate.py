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
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EXTENSIONS = {".ets", ".ts", ".tsx", ".js", ".jsx", ".kt", ".kts", ".java", ".swift", ".m", ".mm", ".h", ".hpp", ".cpp", ".cc", ".gradle", ".json", ".json5", ".xml", ".yaml", ".yml", ".properties"}
SKIP = {".git", ".idea", ".hvigor", ".codebuddy", ".codex", ".claude", "AI", "build", "dist", "node_modules", "oh_modules", "Pods"}
DECLARATION = re.compile(r"\b(?:class|interface|struct|enum|object|function|func|def|const|let|var)\s+([A-Za-z_$][\w$]*)")
EXPORTED_DECLARATION = re.compile(r"\bexport\s+(?:default\s+)?(?:class|interface|struct|enum|object|function|func)\s+([A-Za-z_$][\w$]*)")
OBJC_DECLARATION = re.compile(r"@(?:interface|implementation|protocol)\s+([A-Za-z_][\w]*)")

# 角色按平台命名习惯判定（L1）：模型拿到入口后不再盲探文件职责。
ROLE_RULES: dict[str, list[tuple[re.Pattern[str], str]]] = {
    "harmony": [
        (re.compile(r"Page$"), "页面"),
        (re.compile(r"ViewModel$"), "视图模型"),
        (re.compile(r"(?:NetApi|NetService|Api)$"), "网络请求"),
        (re.compile(r"(?:ListItem|ItemView|Item)$"), "列表项视图"),
        (re.compile(r"(?:Dialog|DialogView|Pop)"), "弹窗"),
        (re.compile(r"(?:Bean|Model|Entity|Dto)$"), "数据模型"),
        (re.compile(r"Manager$"), "业务管理"),
        (re.compile(r"(?:Util|Utils|Helper)"), "工具"),
    ],
    "android": [
        (re.compile(r"Activity$"), "页面"),
        (re.compile(r"Fragment$"), "页面片段"),
        (re.compile(r"ViewModel$"), "视图模型"),
        (re.compile(r"Repository$"), "数据仓库"),
        (re.compile(r"(?:Bean|Model|Entity|Dto)$"), "数据模型"),
        (re.compile(r"(?:Api|ApiService)$"), "网络请求"),
        (re.compile(r"Service$"), "业务服务"),
        (re.compile(r"Manager$"), "业务管理"),
        (re.compile(r"(?:Adapter|ViewHolder)$"), "列表适配"),
        (re.compile(r"(?:Util|Utils|Helper)"), "工具"),
    ],
    "ios": [
        (re.compile(r"(?:VC|ViewController|Controller)$"), "页面控制器"),
        (re.compile(r"ViewModel$"), "视图模型"),
        (re.compile(r"(?:Model|Entity|Dto)$"), "数据模型"),
        (re.compile(r"Cell$"), "列表项视图"),
        (re.compile(r"View$"), "视图"),
        (re.compile(r"(?:API|Api|Request|NetApi)$"), "网络请求"),
        (re.compile(r"Manager$"), "业务管理"),
        (re.compile(r"Service$"), "业务服务"),
        (re.compile(r"(?:Helper|Util)"), "工具"),
    ],
}

# data_flow（L2）类目 ← 角色；按类目挑代表文件，让模型直接看到链路入口。
FLOW_CATEGORIES: list[tuple[str, tuple[str, ...]]] = [
    ("net_api", ("网络请求",)),
    ("model", ("数据模型", "数据仓库")),
    ("view_model", ("视图模型",)),
    ("page", ("页面", "页面控制器", "页面片段")),
    ("view", ("列表项视图", "列表适配", "视图", "弹窗")),
]


def role_of(platform: str, stem: str) -> str | None:
    for pattern, role in ROLE_RULES.get(platform, []):
        if pattern.search(stem):
            return role
    return None


def key_symbols(text: str, stem: str, limit: int = 4) -> list[str]:
    """提取文件关键符号（Name@行号）：优先与文件名同名的导出声明，再按出现顺序补齐。"""
    found: list[tuple[str, int]] = []
    seen: set[str] = set()

    def collect(pattern: re.Pattern[str], only_stem: bool, skip_locals: bool = False) -> None:
        for match in pattern.finditer(text):
            name = match.group(1)
            # 兜底遍历时跳过小写开头的局部变量（const params / let bean 之类）
            if name in seen or (only_stem and norm(name) != norm(stem)) or (skip_locals and name[0].islower()):
                continue
            seen.add(name)
            found.append((name, text[: match.start()].count("\n") + 1))
            if len(found) >= limit:
                return

    collect(EXPORTED_DECLARATION, only_stem=True)
    collect(OBJC_DECLARATION, only_stem=True)
    if len(found) < limit:
        collect(EXPORTED_DECLARATION, only_stem=False)
    if len(found) < limit:
        collect(OBJC_DECLARATION, only_stem=False)
    if len(found) < limit:
        collect(DECLARATION, only_stem=False, skip_locals=True)
    return [f"{name}@{line}" for name, line in sorted(found[:limit], key=lambda item: item[1])]


def data_flow(paths: list[dict[str, Any]], per_category: int = 2) -> dict[str, list[str]]:
    flow: dict[str, list[str]] = {}
    for category, roles in FLOW_CATEGORIES:
        members = [item["path"] for item in paths if item.get("role") in roles]
        if members:
            flow[category] = members[:per_category]
    return flow


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
    path_text = norm(relative)
    content_text = norm(content)
    keywords = [term for term in rule.get("keywords", [])
                if norm(term) and (norm(term) in path_text or norm(term) in content_text)]
    hints = [term for term in rule.get("path_hints", [])
             if norm(term) and norm(term) in path_text]
    return keywords + hints


def pointers(root: Path, platform: str, paths: list[tuple[Path, list[str]]]) -> list[dict[str, Any]]:
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
        declaration = declaration or next(OBJC_DECLARATION.finditer(text), None)
        declaration = declaration or next(DECLARATION.finditer(text), None)
        symbol = declaration.group(1) if declaration else path.stem
        line_start = text[: declaration.start()].count("\n") + 1 if declaration else 1
        output.append({
            "path": path.relative_to(root).as_posix(),
            "symbol": symbol,
            "role": role_of(platform, path.stem),
            "line_start": line_start,
            "line_end": max(line_start, min(len(lines), line_start + 80)),
            "key_symbols": key_symbols(text, path.stem),
            "terms": sorted(set(terms))[:12],
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path(".data/code-index/sources.json"))
    parser.add_argument("--rules", type=Path, default=Path("code-index/modules.json"))
    parser.add_argument("--output", type=Path, default=Path("code-index/index.jsonl"))
    parser.add_argument("--coverage", type=Path, default=Path("code-index/coverage.json"))
    parser.add_argument("--binary-index", type=Path, default=Path("code-index/binary-index.jsonl"))
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
            pointers_value = pointers(root, base["platform"], [(path, terms) for path, terms, _ in hits])
            if not pointers_value:
                continue
            entry_id = hashlib.sha256(f"{rule['module_id']}|{base['platform']}|{base['product_line']}|{base['form_factor']}|{base['version']}|{base['repository_id']}|{base['resolved_commit']}".encode()).hexdigest()[:24]
            records.append({
                "schema_version": 1, "entry_id": entry_id, "record_type": "module",
                "title": rule["title"], "module_id": rule["module_id"], "aliases": rule.get("aliases", []),
                "keywords": rule.get("keywords", []), **base, "paths": pointers_value,
                "data_flow": data_flow(pointers_value),
                "related_modules": [], "source": "generated", "generated_at": generated,
                "matched_file_count": len(hits), "mapping_method": "lexical-source-scan",
            })
            item["modules"].append({"module_id": rule["module_id"], "matched_file_count": len(hits)})
        coverage.append(item)
    for failure in manifest.get("failures", []):
        coverage.append({
            "key": failure.get("key"),
            "status": failure.get("status", "unavailable"),
            "message": failure.get("message"),
            "limitations": failure.get("limitations", []),
            "modules": [],
        })
    # 二进制证据记录（由 binary_evidence.py 预生成并随仓库入库）：追加进同一份索引，
    # 与源码模块记录共存；缺席时跳过，不视为错误。
    # 陈旧校验：manifest（binary-components.json）比产物新时说明组件清单改过
    # 但没重跑 binary_evidence.py，产物可信度存疑——告警不阻断。
    binary_records: list[dict[str, Any]] = []
    if args.binary_index.exists():
        manifest_path = args.binary_index.with_name("binary-components.json")
        if manifest_path.exists() and manifest_path.stat().st_mtime > args.binary_index.stat().st_mtime:
            print(
                "WARN: binary-index.jsonl 比 binary-components.json 旧，"
                "组件清单更新后未重跑 binary_evidence.py，二进制证据可能陈旧",
                file=sys.stderr,
            )
        binary_records = [
            json.loads(line)
            for line in args.binary_index.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        records.extend(binary_records)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in records), encoding="utf-8")
    args.coverage.write_text(json.dumps({"generated_at": generated, "source_count": len(coverage), "entry_count": len(records), "binary_component_count": len(binary_records), "sources": coverage}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"entries": len(records), "sources": len(coverage), "ready": sum(item["status"] == "ready" for item in coverage)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
