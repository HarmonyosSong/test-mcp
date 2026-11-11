from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from fastmcp import Client

from harmony_repo_mcp import ProjectInspector, create_mcp_server
from harmony_repo_mcp.code_index import CodeIndexBackend, CodeIndexUnavailable


def _setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "Entry.ets").write_text("struct Entry { build() {} }\n", encoding="utf-8")
    calls = tmp_path / "calls.jsonl"
    control = tmp_path / "control.json"
    control.write_text("{}")
    executable = tmp_path / "fake-code-index"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, pathlib, sys, time\n"
        f"control = json.loads(pathlib.Path({str(control)!r}).read_text())\n"
        "if sys.argv[1:] == ['--version']:\n"
        "  print(control.get('version', 'codebase-memory-mcp 0.12.1')); sys.exit()\n"
        "tool, args = sys.argv[-2], json.loads(sys.argv[-1])\n"
        "entry = {'tool': tool, 'args': args, 'pid': os.getpid(), "
        "'secret_seen': 'DEEPSEEK_API_KEY' in os.environ, "
        "'engine_cache': os.environ['CBM_CACHE_DIR']}\n"
        "if tool == 'index_repository':\n"
        "  root = pathlib.Path(args['repo_path'])\n"
        "  entry['copied_files'] = sorted(str(p.relative_to(root)) for p in root.rglob('*') "
        "if p.is_file())\n"
        f"with pathlib.Path({str(calls)!r}).open('a') as stream:\n"
        "  stream.write(json.dumps(entry) + '\\n')\n"
        "if control.get('delay_tool') == tool: time.sleep(30)\n"
        "if control.get('flood_tool') == tool:\n"
        "  print('x' * 600000, flush=True); time.sleep(30)\n"
        "if control.get('error_tool') == tool:\n"
        "  print(json.dumps({'isError': True, 'content': []})); sys.exit(1)\n"
        "if control.get('missing_tool') == tool:\n"
        "  print(json.dumps({'isError': True, 'structuredContent': "
        "{'error': 'function not found'}})); sys.exit(1)\n"
        "if tool == 'index_repository': result = {'status': 'indexed', 'nodes': 2}\n"
        "elif tool == 'search_graph': result = {\n"
        "  'cols': ['qn', 'label', 'file', 'lines'],\n"
        "  'rows': [['demo.Entry', 'Struct', 'Entry.ets', '1-1']], 'total': 1}\n"
        "elif tool == 'get_file_outline': result = {\n"
        "  'file_path': 'Entry.ets', 'cols': ['name', 'label', 'lines'],\n"
        "  'rows': [['Entry', 'Struct', '1-1']]}\n"
        "elif tool == 'trace_path': result = {\n"
        "  'function': 'build', 'callers_total': 0, 'callers': {'groups': []}}\n"
        "else: sys.exit(4)\n"
        "print(json.dumps({'structuredContent': result, 'isError': False}))\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    monkeypatch.setenv("HARMONY_AGENT_CODE_INDEX_COMMAND", str(executable))
    # Intentionally inside the workspace: the cache must not index itself.
    monkeypatch.setenv("HARMONY_AGENT_CODE_INDEX_CACHE", str(workspace / "cache"))
    monkeypatch.setenv("HARMONY_AGENT_CODE_INDEX_MODE", "fast")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-only-private-key")
    return workspace, calls, control


def _calls(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


@pytest.mark.asyncio
async def test_code_navigation_is_hidden_until_backend_is_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("HARMONY_AGENT_CODE_INDEX_COMMAND", raising=False)
    async with Client(create_mcp_server(tmp_path)) as client:
        names = {tool.name for tool in await client.list_tools()}
    assert names == {
        "list_project_files",
        "search_project_text",
        "read_project_file",
        "parse_hilog",
        "load_business_context",
    }


@pytest.mark.asyncio
async def test_mcp_navigation_is_private_read_only_and_reuses_one_scoped_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace, calls, _ = _setup(tmp_path, monkeypatch)
    (workspace / "image.png").write_bytes(b"image")
    (workspace / "node_modules").mkdir()
    (workspace / "node_modules" / "Private.ts").write_text("class Private {}")
    outside = tmp_path / "Outside.ets"
    outside.write_text("struct Outside {}")
    (workspace / "Link.ets").symlink_to(outside)
    (workspace / "Huge.ts").write_bytes(b"x" * 512001)
    original = (workspace / "Entry.ets").read_bytes()
    async with Client(create_mcp_server(workspace)) as client:
        tools = {tool.name: tool for tool in await client.list_tools()}
        symbols = await client.call_tool("search_code_symbols", {"query": "Entry", "limit": 5})
        outline = await client.call_tool("get_code_outline", {"relative_path": "Entry.ets"})
        trace = await client.call_tool("trace_code_path", {"function_name": "build"})
        source = await client.call_tool("read_project_file", {"relative_path": "Entry.ets"})
        escape = await client.call_tool(
            "get_code_outline", {"relative_path": "../Outside.ets"}, raise_on_error=False
        )
    names = {"search_code_symbols", "get_code_outline", "trace_code_path"}
    assert set(tools) == names | {
        "list_project_files",
        "search_project_text",
        "read_project_file",
        "parse_hilog",
        "load_business_context",
    }
    assert all(tools[name].annotations.readOnlyHint for name in names)
    assert not any(result.is_error for result in (symbols, outline, trace, source))
    assert "not observed evidence" in symbols.structured_content["evidence_boundary"]
    assert trace.structured_content["navigation"]["callers_total"] == 0
    assert escape.is_error
    records = _calls(calls)
    assert [entry["tool"] for entry in records] == [
        "index_repository",
        "search_graph",
        "get_file_outline",
        "trace_path",
    ]
    assert records[0]["copied_files"] == ["Entry.ets"]
    assert records[0]["args"]["persistence"] is False
    assert records[0]["args"]["mode"] == "fast"
    assert not Path(records[0]["args"]["repo_path"]).is_relative_to(
        Path(records[0]["engine_cache"])
    )
    assert not any(entry["secret_seen"] for entry in records)
    assert (workspace / "Entry.ets").read_bytes() == original
    assert not (workspace / ".codebase-memory").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["missing", '"unterminated'])
async def test_missing_backend_reports_error_instead_of_no_matches(tmp_path, monkeypatch, command):
    monkeypatch.setenv("HARMONY_AGENT_CODE_INDEX_COMMAND", command)
    async with Client(create_mcp_server(tmp_path)) as client:
        names = {tool.name for tool in await client.list_tools()}
        result = await client.call_tool(
            "search_code_symbols", {"query": "Entry"}, raise_on_error=False
        )
    assert "search_code_symbols" in names
    assert result.is_error and "not executable" in str(result.content)


@pytest.mark.asyncio
async def test_changed_source_is_rejected_and_next_backend_uses_new_identity(tmp_path, monkeypatch):
    workspace, calls, _ = _setup(tmp_path, monkeypatch)
    backend = CodeIndexBackend(ProjectInspector(workspace))
    first = await backend.search_symbols("Entry")
    (workspace / "Entry.ets").write_text("struct Changed {}\n")
    with pytest.raises(CodeIndexUnavailable, match="code_index_stale"):
        await backend.search_symbols("Changed")
    second = await CodeIndexBackend(ProjectInspector(workspace)).search_symbols("Changed")
    assert first["snapshot_id"] != second["snapshot_id"]
    assert len([r for r in _calls(calls) if r["tool"] == "index_repository"]) == 2


@pytest.mark.asyncio
async def test_corrupted_cached_copy_is_not_reused(tmp_path, monkeypatch):
    workspace, _, _ = _setup(tmp_path, monkeypatch)
    backend = CodeIndexBackend(ProjectInspector(workspace))
    await backend.search_symbols("Entry")
    assert backend._source_dir
    (backend._source_dir / "Entry.ets").write_text("struct Wrong {}")
    with pytest.raises(CodeIndexUnavailable, match="code_index_cache_invalid"):
        await CodeIndexBackend(ProjectInspector(workspace)).search_symbols("Entry")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ["unsupported_version", "backend_error", "output_limit", "symbol_missing"]
)
async def test_backend_failures_are_distinct_from_empty_results(tmp_path, monkeypatch, failure):
    workspace, _, control = _setup(tmp_path, monkeypatch)
    behavior, message = {
        "unsupported_version": ({"version": "codebase-memory-mcp 0.13.0"}, "unsupported"),
        "backend_error": ({"error_tool": "search_graph"}, "code_index_failed"),
        "output_limit": ({"flood_tool": "search_graph"}, "code_index_output_limit"),
        "symbol_missing": ({"missing_tool": "search_graph"}, "code_index_symbol_not_found"),
    }[failure]
    control.write_text(json.dumps(behavior))
    backend = CodeIndexBackend(ProjectInspector(workspace))
    with pytest.raises(CodeIndexUnavailable, match=message):
        await asyncio.wait_for(backend.search_symbols("Entry"), timeout=8)


@pytest.mark.asyncio
async def test_timeout_and_cancellation_stop_cli_process(tmp_path, monkeypatch):
    workspace, calls, control = _setup(tmp_path, monkeypatch)
    backend = CodeIndexBackend(ProjectInspector(workspace))
    await backend.search_symbols("Entry")
    control.write_text(json.dumps({"delay_tool": "search_graph"}))
    backend.timeout_seconds = 0.15
    with pytest.raises(CodeIndexUnavailable, match="code_index_timeout"):
        await asyncio.wait_for(backend.search_symbols("Entry"), timeout=5)
    with pytest.raises(ProcessLookupError):
        os.kill(_calls(calls)[-1]["pid"], 0)
    backend.timeout_seconds = 30
    count = len(_calls(calls))
    task = asyncio.create_task(backend.search_symbols("Entry"))
    async with asyncio.timeout(5):
        while len(_calls(calls)) == count:
            await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=5)
    with pytest.raises(ProcessLookupError):
        os.kill(_calls(calls)[-1]["pid"], 0)


@pytest.mark.asyncio
async def test_query_is_one_json_argument_and_large_navigation_is_explicitly_bounded(
    tmp_path, monkeypatch
):
    workspace, calls, _ = _setup(tmp_path, monkeypatch)
    backend = CodeIndexBackend(ProjectInspector(workspace))
    query = "--project other $(touch /tmp/should-not-run)"
    await backend.search_symbols(query, limit=999)
    args = _calls(calls)[-1]["args"]
    assert args["query"] == query and args["limit"] == 50
    result = backend._bound_result({"rows": [["x" * 2000] for _ in range(100)]})
    assert result["adapter_truncated"]
    assert result["navigation"]["reason"] == "output_budget"
    assert len(json.dumps(result)) < 16000


def test_source_inspector_supports_three_client_platforms(tmp_path: Path) -> None:
    paths = {
        "Screen.swift": "struct Screen {}\n",
        "Bridge.mm": "void bridge() {}\n",
        "MainActivity.kt": "class MainActivity\n",
        "MainActivity.java": "class MainActivity {}\n",
        "Entry.ets": "struct Entry {}\n",
    }
    for relative, content in paths.items():
        (tmp_path / relative).write_text(content, encoding="utf-8")
    inspector = ProjectInspector(tmp_path)
    assert set(inspector.list_project_files()) == set(paths)
    for relative in paths:
        assert inspector.read_project_file(relative).content
