from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

CODE_INDEX_FILE_ENV = "HARMONY_AGENT_CODE_INDEX_FILE"
CODE_INDEX_SCOPE_FILE_ENV = "HARMONY_AGENT_CODE_INDEX_SCOPE_FILE"
DEFAULT_INDEX_FILE = "code-index/index.jsonl"
DEFAULT_SCOPE_FILE = "code-index/version-scope.json"

CODE_INDEX_TOOL_NAMES = [
    "list_code_index_scopes",
    "search_code_index",
    "get_code_index_entry",
]


class IndexPath(BaseModel):
    path: str = Field(min_length=1)
    symbol: str | None = None
    line_start: int | None = Field(default=None, ge=1)
    line_end: int | None = Field(default=None, ge=1)
    terms: list[str] = Field(default_factory=list)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        path = value.replace("\\", "/")
        if path.startswith("/") or any(part in {"", ".", ".."} for part in path.split("/")):
            raise ValueError("code index path must be a safe relative path")
        return path

    @model_validator(mode="after")
    def validate_line_range(self) -> IndexPath:
        if (
            self.line_end is not None
            and self.line_start is not None
            and self.line_end < self.line_start
        ):
            raise ValueError("line_end must not precede line_start")
        return self


class IndexEntry(BaseModel):
    schema_version: int = Field(default=1, ge=1)
    entry_id: str = Field(min_length=1)
    record_type: str = Field(default="module", min_length=1)
    title: str = Field(min_length=1)
    module_id: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    platform: str = Field(min_length=1)
    product_line: str | None = None
    form_factor: str | None = None
    version: str = Field(min_length=1)
    build: str | None = None
    repository_id: str = Field(min_length=1)
    resolved_commit: str = Field(min_length=1)
    paths: list[IndexPath] = Field(min_length=1)
    related_modules: list[str] = Field(default_factory=list)
    source: str = Field(default="generated", min_length=1)
    generated_at: str | None = None
    matched_file_count: int | None = Field(default=None, ge=1)
    mapping_method: str = Field(default="lexical-source-scan", min_length=1)

    @field_validator("resolved_commit")
    @classmethod
    def validate_commit(cls, value: str) -> str:
        if not re.fullmatch(r"[0-9a-f]{40,64}", value):
            raise ValueError("resolved_commit must be an immutable Git SHA")
        return value

    def searchable_text(self) -> str:
        values: list[str] = [
            self.entry_id,
            self.title,
            self.module_id,
            *self.aliases,
            *self.keywords,
            *self.related_modules,
            *[path.path for path in self.paths],
            *[path.symbol or "" for path in self.paths],
            *[term for path in self.paths for term in path.terms],
        ]
        return " ".join(values).casefold()


def _resolve_path(value: str | None, default: str) -> Path:
    return Path(value or default).expanduser().resolve()


def _load_scope(path: Path) -> dict[str, list[str]]:
    if not path.exists():
        return {"default": ["7.106.0", "7.105.0"], "hd": ["5.105.0", "7.105.0"]}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("code index scope file must be an object")
    scope: dict[str, list[str]] = {}
    for key, values in raw.items():
        if (
            not isinstance(key, str)
            or not isinstance(values, list)
            or not all(isinstance(v, str) for v in values)
        ):
            raise ValueError("code index scope values must be string arrays")
        scope[key] = list(dict.fromkeys(values))
    if "default" not in scope:
        raise ValueError("code index scope must define default versions")
    return scope


def _load_entries(path: Path) -> list[IndexEntry]:
    if not path.exists():
        return []
    entries: list[IndexEntry] = []
    seen: set[str] = set()
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            entry = IndexEntry.model_validate_json(raw)
        except ValidationError as error:
            raise ValueError(
                f"invalid code index JSONL at {path}:{line_number}: {error}"
            ) from error
        if entry.entry_id in seen:
            raise ValueError(f"duplicate code index entry_id: {entry.entry_id}")
        seen.add(entry.entry_id)
        entries.append(entry)
    return entries


def _scope_key(form_factor: str | None) -> str:
    if form_factor in {"hd", "pad"}:
        return "hd"
    return "default"


def _allowed_versions(scope: dict[str, list[str]], form_factor: str | None) -> set[str]:
    if form_factor is None:
        return set(scope.get("default", [])) | set(scope.get("hd", []))
    return set(scope.get(_scope_key(form_factor), scope["default"]))


def _identity_terms(entry: IndexEntry) -> list[str]:
    return [entry.title, *entry.aliases]


def _score_entry(entry: IndexEntry, query: str, terms: list[str]) -> int:
    """确定性词法打分；0 分表示不命中。

    索引每个版本窗只有十几条条目，全库几百条——这个体量不需要向量/BM25，
    可解释的词法匹配足够。关键是准入要宽（任一信号即可候选），排序交给分数。
    """
    haystack = entry.searchable_text()
    identity = " ".join(_identity_terms(entry)).casefold()
    score = 0
    if query and query in haystack:
        score += 5
    for term in terms:
        if term in identity:
            score += 3
            continue
        if term in haystack:
            score += 1
            continue
        # 中文复合查询词没有空格分词（如「跨报成功记录」）：当条目标题/别名
        # 是查询词的子串时给分，按最长命中别名加权，避免单字噪音。
        alias_lengths = [
            len(alias)
            for alias in _identity_terms(entry)
            if len(alias) >= 2 and alias.casefold() in term
        ]
        if alias_lengths:
            score += 2 + min(max(alias_lengths), 6)
    return score


def _public(entry: IndexEntry, *, score: int | None = None) -> dict[str, Any]:
    value = entry.model_dump(mode="json")
    value["navigation_only"] = True
    value["evidence_boundary"] = (
        "索引只提供定位线索；必须用 read_project_file 读取同一 commit 的源码后才能作为证据。"
    )
    if score is not None:
        value["score"] = score
    return value


def create_code_index_server(
    index_file: Path | None = None,
    scope_file: Path | None = None,
) -> FastMCP:
    path = _resolve_path(
        str(index_file) if index_file else os.environ.get(CODE_INDEX_FILE_ENV), DEFAULT_INDEX_FILE
    )
    scope_path = _resolve_path(
        str(scope_file) if scope_file else os.environ.get(CODE_INDEX_SCOPE_FILE_ENV),
        DEFAULT_SCOPE_FILE,
    )
    scope = _load_scope(scope_path)
    entries = _load_entries(path)
    server = FastMCP(
        "harmony-code-index",
        instructions=(
            "Read-only version-scoped code catalog. Results are navigation hints, "
            "never source evidence. "
            "Use the repository snapshot tools to read the returned path at the returned commit."
        ),
    )

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def list_code_index_scopes() -> dict[str, Any]:
        """List configured code-index version scopes."""
        return {
            "index_file": str(path),
            "entry_count": len(entries),
            "scopes": scope,
            "navigation_only": True,
        }

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def search_code_index(
        query: str,
        platform: str | None = None,
        product_line: str | None = None,
        form_factor: str | None = None,
        version: str | None = None,
        build: str | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Search module/file/symbol pointers within the configured version window."""
        if not query.strip():
            return {"status": "invalid_query", "results": [], "navigation_only": True}
        allowed = _allowed_versions(scope, form_factor)
        folded_query = query.casefold()
        terms = [part for part in folded_query.split() if part]

        def collect(*, enforce_version: bool) -> list[tuple[int, IndexEntry]]:
            found: list[tuple[int, IndexEntry]] = []
            for entry in entries:
                entry_allowed = _allowed_versions(scope, entry.form_factor)
                if entry.version not in entry_allowed or entry.version not in allowed:
                    continue
                if platform and entry.platform != platform:
                    continue
                if product_line and entry.product_line != product_line:
                    continue
                if form_factor and entry.form_factor not in {
                    form_factor,
                    "universal",
                    "hd" if form_factor == "pad" else form_factor,
                }:
                    continue
                if enforce_version and version and entry.version != version:
                    continue
                if build and entry.build != build:
                    continue
                score = _score_entry(entry, folded_query, terms)
                if score > 0:
                    found.append((score, entry))
            return found

        candidates = collect(enforce_version=True)
        # 指定版本零命中时回落到窗口内其它版本：模块归属很少随小版本剧变，
        # 结果必须如实标注 version_fallback，由调用方按导航线索到真实版本核实。
        version_fallback = False
        if not candidates and version:
            candidates = collect(enforce_version=False)
            version_fallback = bool(candidates)
        candidates.sort(key=lambda item: (-item[0], item[1].entry_id))
        bounded_limit = max(1, min(limit, 50))
        return {
            "status": "ok" if candidates else "no_match",
            "query": query,
            "allowed_versions": sorted(allowed),
            "version_fallback": version_fallback,
            "results": [_public(entry, score=score) for score, entry in candidates[:bounded_limit]],
            "truncated": len(candidates) > bounded_limit,
            "navigation_only": True,
        }

    @server.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def get_code_index_entry(entry_id: str) -> dict[str, Any]:
        """Read one code-index pointer by stable entry ID."""
        entry = next((item for item in entries if item.entry_id == entry_id), None)
        if entry is None:
            return {"status": "not_found", "entry_id": entry_id, "navigation_only": True}
        if entry.version not in _allowed_versions(scope, entry.form_factor):
            return {"status": "outside_scope", "entry_id": entry_id, "navigation_only": True}
        return {"status": "ok", "entry": _public(entry), "navigation_only": True}

    return server


def run() -> None:
    create_code_index_server().run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    run()
