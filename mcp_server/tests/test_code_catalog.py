from pathlib import Path

import pytest
from fastmcp import Client

from harmony_code_index_mcp import create_code_index_server


def write_fixture(root: Path) -> tuple[Path, Path]:
    index = root / "index.jsonl"
    index.write_text(
        "\n".join(
            [
                '{"entry_id":"harmony-cross-71050","title":"跨报成功记录","module_id":"cross-report","aliases":["去结算","多退少补"],"keywords":["kuabaoStatus"],"platform":"harmony","product_line":"xueersi","form_factor":"pad","version":"7.105.0","repository_id":"harmony/xesapp","resolved_commit":"a","paths":[{"path":"CrossReport.ets","symbol":"CrossReportSucceedListItem","line_start":112,"terms":["goPaymentVisible"]}]}',
                '{"entry_id":"android-cross-71050","title":"跨报成功记录","module_id":"cross-report","aliases":["去结算"],"keywords":["kuabaoStatus"],"platform":"android","product_line":"xueersi","form_factor":"phone","version":"7.105.0","repository_id":"android/xesapp","resolved_commit":"b","paths":[{"path":"CrossReport.kt","symbol":"CrossReportSucceedListItem","line_start":88}]}',
                '{"entry_id":"old-entry","title":"旧逻辑","module_id":"old","aliases":["旧"],"platform":"harmony","product_line":"xueersi","form_factor":"pad","version":"7.104.0","repository_id":"harmony/xesapp","resolved_commit":"c","paths":[{"path":"Old.ets"}]}',
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


def test_invalid_jsonl_is_rejected(tmp_path: Path) -> None:
    index = tmp_path / "bad.jsonl"
    index.write_text('{"entry_id":"broken"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="invalid code index JSONL"):
        create_code_index_server(index, tmp_path / "missing-scope.json")
