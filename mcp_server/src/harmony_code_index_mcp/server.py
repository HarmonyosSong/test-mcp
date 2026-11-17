from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from pydantic import BaseModel, Field, ValidationError

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
    return set(scope.get(_scope_key(form_factor), scope["default"]))


def _matches(entry: IndexEntry, query: str) -> bool:
    terms = [part for part in query.casefold().split() if part]
    haystack = entry.searchable_text()
    return all(term in haystack for term in terms)


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
        candidates: list[tuple[int, IndexEntry]] = []
        for entry in entries:
            if entry.version not in allowed:
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
            if version and entry.version != version:
                continue
            if build and entry.build != build:
                continue
            if not _matches(entry, query):
                continue
            text = entry.searchable_text()
            score = sum(2 if term in text else 0 for term in query.casefold().split())
            score += 1 if query.casefold() in text else 0
            candidates.append((score, entry))
        candidates.sort(key=lambda item: (-item[0], item[1].entry_id))
        bounded_limit = max(1, min(limit, 50))
        return {
            "status": "ok" if candidates else "no_match",
            "query": query,
            "allowed_versions": sorted(allowed),
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
