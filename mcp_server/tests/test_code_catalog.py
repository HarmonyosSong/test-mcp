from pathlib import Path

import pytest
from fastmcp import Client

from harmony_code_index_mcp import create_code_index_server


def write_fixture(root: Path) -> tuple[Path, Path]:
    index = root / "index.jsonl"
    index.write_text(
        "\n".join(
            [
                '{"entry_id":"harmony-cross-71050","title":"跨报成功记录","module_id":"cross-report","aliases":["去结算","多退少补"],"keywords":["kuabaoStatus"],"platform":"harmony","product_line":"xueersi","form_factor":"pad","version":"7.105.0","repository_id":"harmony/xesapp","resolved_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","paths":[{"path":"CrossReport.ets","symbol":"CrossReportSucceedListItem","line_start":112,"terms":["goPaymentVisible"]}]}',
                '{"entry_id":"android-cross-71050","title":"跨报成功记录","module_id":"cross-report","aliases":["去结算"],"keywords":["kuabaoStatus"],"platform":"android","product_line":"xueersi","form_factor":"phone","version":"7.105.0","repository_id":"android/xesapp","resolved_commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","paths":[{"path":"CrossReport.kt","symbol":"CrossReportSucceedListItem","line_start":88}]}',
                '{"entry_id":"old-entry","title":"旧逻辑","module_id":"old","aliases":["旧"],"platform":"harmony","product_line":"xueersi","form_factor":"pad","version":"7.104.0","repository_id":"harmony/xesapp","resolved_commit":"cccccccccccccccccccccccccccccccccccccccc","paths":[{"path":"Old.ets"}]}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    scope = root / "scope.json"
    scope.write_text(
        '{"default":["7.106.0","7.105.0"],"hd":["5.105.0","7.105.0"]}', encoding="utf-8"
    )
    return index, scope


@pytest.mark.asyncio
async def test_code_index_filters_version_scope_and_returns_navigation_boundary(
    tmp_path: Path,
) -> None:
    index, scope = write_fixture(tmp_path)
    async with Client(create_code_index_server(index, scope)) as client:
        result = await client.call_tool(
            "search_code_index",
            {"query": "去结算", "platform": "harmony", "form_factor": "pad"},
        )
        old = await client.call_tool("get_code_index_entry", {"entry_id": "old-entry"})
        scopes = await client.call_tool("list_code_index_scopes", {})
    assert result.structured_content["status"] == "ok"
    assert [row["entry_id"] for row in result.structured_content["results"]] == [
        "harmony-cross-71050"
    ]
    assert result.structured_content["results"][0]["navigation_only"] is True
    assert "read_project_file" in result.structured_content["results"][0]["evidence_boundary"]
    assert old.structured_content["status"] == "outside_scope"
    assert scopes.structured_content["scopes"]["hd"] == ["5.105.0", "7.105.0"]


@pytest.mark.asyncio
async def test_search_admits_partial_term_hits_for_compound_chinese_query(
    tmp_path: Path,
) -> None:
    """回归：线上真实查询「跨报成功记录 去结算 多退少补」曾因 all-terms 匹配零命中。"""
    index, scope = write_fixture(tmp_path)
    async with Client(create_code_index_server(index, scope)) as client:
        result = await client.call_tool(
            "search_code_index",
            {
                "query": "跨报成功记录 去结算 多退少补",
                "platform": "harmony",
                "product_line": "xueersi",
                "form_factor": "pad",
                "version": "7.105.0",
            },
        )
        unrelated = await client.call_tool(
            "search_code_index",
            {"query": "完全无关的功能点", "platform": "harmony"},
        )
    data = result.structured_content
    assert data["status"] == "ok"
    assert data["version_fallback"] is False
    # 复合词「跨报成功记录」通过标题反向子串命中，「去结算」「多退少补」命中别名
    assert data["results"][0]["entry_id"] == "harmony-cross-71050"
    assert data["results"][0]["score"] > 0
    assert unrelated.structured_content["status"] == "no_match"


@pytest.mark.asyncio
async def test_search_falls_back_to_sibling_versions_with_annotation(
    tmp_path: Path,
) -> None:
    """指定版本零命中时回落到版本窗内的邻近版本，并标注 version_fallback。"""
    index, scope = write_fixture(tmp_path)
    async with Client(create_code_index_server(index, scope)) as client:
        result = await client.call_tool(
            "search_code_index",
            {
                "query": "去结算",
                "platform": "harmony",
                "form_factor": "pad",
                "version": "7.106.0",
            },
        )
    data = result.structured_content
    assert data["status"] == "ok"
    assert data["version_fallback"] is True
    assert data["results"][0]["entry_id"] == "harmony-cross-71050"
    assert data["results"][0]["version"] == "7.105.0"


def test_invalid_jsonl_is_rejected(tmp_path: Path) -> None:
    index = tmp_path / "bad.jsonl"
    index.write_text('{"entry_id":"broken"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="invalid code index JSONL"):
        create_code_index_server(index, tmp_path / "missing-scope.json")


def test_jsonl_rejects_unsafe_paths_and_non_commit_ids(tmp_path: Path) -> None:
    index = tmp_path / "unsafe.jsonl"
    index.write_text(
        '{"entry_id":"unsafe","title":"unsafe","module_id":"x","platform":"ios",'
        '"version":"7.105.0","repository_id":"ios/app",'
        '"resolved_commit":"not-a-sha","paths":[{"path":"../secret.swift"}]}\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="invalid code index JSONL"):
        create_code_index_server(index, tmp_path / "missing-scope.json")
