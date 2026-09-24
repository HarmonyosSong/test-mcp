from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import Draft202012Validator

CONTRACT_DIR = Path(__file__).with_name("dev_knowledge_contract")


@lru_cache
def _validator(tool: str) -> Draft202012Validator:
    schema = json.loads((CONTRACT_DIR / "mcp-responses.schema.json").read_text())
    return Draft202012Validator({"$defs": schema["$defs"], **schema["properties"][tool]})


def identity(value: dict[str, Any]) -> tuple[str, str, str]:
    return value["business_line"], value["product_id"], value["topic_id"]


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_response(tool: str, args: dict[str, Any], value: dict[str, Any]) -> None:
    # Structural contracts are upstream-owned; request and citation checks are consumer-owned.
    _validator(tool).validate(value)
    _require(bool(value.get("truncated")) == (value.get("truncation") is not None), "truncation")
    status = value["status"]
    if tool == "wiki_resolve" and status in {"resolved", "ambiguous", "not_found"}:
        _require(value["query"] == args["query"], "query echo")
        candidates = value["candidates"]
        _require(len(candidates) <= args["limit"], "candidate limit")
        _require(len({identity(c) for c in candidates}) == len(candidates), "duplicate topic")
        for candidate in candidates:
            _require(candidate["business_line"] == args["business_line"], "business line")
            _require(candidate["product_id"] == args["product_id"], "product scope")
        if status == "resolved":
            _require(len(candidates) == 1 and candidates[0]["confidence"] == "high", "resolved")
            resolution = value.get("resolution") or {}
            _require(resolution.get("credible_candidate_count") == 1, "resolution count")
            _require(resolution.get("confidence") == "high", "resolution confidence")
        elif status == "not_found":
            _require(not candidates, "not_found with candidates")
        else:
            _require(bool(candidates), "ambiguous without candidates")
    if tool != "wiki_read":
        return
    if "key" in value:
        _require(identity(value["key"]) == identity(args), "read key")
    if status != "ok":
        return
    _require(identity(value["topic"]) == identity(args), "topic identity")
    sections = value["sections"]
    section_ids = [s["section_id"] for s in sections]
    _require(len(set(section_ids)) == len(section_ids), "duplicate section")
    _require(set(section_ids) <= set(args["section_ids"]), "unrequested section")
    if not value.get("truncated"):
        _require(set(section_ids) == set(args["section_ids"]), "missing section")
    refs = {ref for s in sections for item in s["items"] for ref in item["source_ref_keys"]}
    catalog = value["source_catalog"]
    _require(refs == set(catalog), "source references")
    sources = value["code_sources"]
    used = set()
    for locator in catalog.values():
        path = locator["relative_path"]
        _require(
            bool(path)
            and not PurePosixPath(path).is_absolute()
            and ".." not in PurePosixPath(path).parts
            and "\\" not in path
            and ":" not in path,
            "unsafe source path",
        )
        if locator["kind"] != "code":
            _require(
                all(len(r) == 2 and 1 <= r[0] <= r[1] for r in locator["line_ranges"]),
                "document lines",
            )
            continue
        source_id = locator["code_source_id"]
        _require(source_id in sources, "missing code source")
        source = sources[source_id]
        used.add(source_id)
        _require(locator["source_id"] == source["source_role"], "source role")
        _require(locator["start_line"] <= locator["end_line"], "source lines")
        matches = {
            s["service_id"]
            for s in source["logical_services"]
            if not s["path_prefix"]
            or path == s["path_prefix"]
            or path.startswith(s["path_prefix"].rstrip("/") + "/")
        }
        _require(set(locator["service_ids"]) == matches, "service scope")
        repo = source["repository"]
        if repo["identity_status"] == "confirmed":
            _require(bool(repo["host"] and repo["full_name"]), "repository identity")
        else:
            _require(repo["host"] is None and repo["full_name"] is None, "missing repository")
    _require(used == set(sources), "unused code sources")
