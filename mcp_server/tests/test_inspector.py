from pathlib import Path

import pytest
from fastmcp import Client

from harmony_repo_mcp import InspectionBoundaryError, ProjectInspector, create_mcp_server


def test_inspector_searches_text_and_blocks_symlink_escape(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    page = project / "LoginPage.ets"
    page.write_text("const reason = 'TypeError';\n", encoding="utf-8")
    outside = tmp_path / "secret.txt"
    outside.write_text("do not read", encoding="utf-8")
    (project / "escape.txt").symlink_to(outside)
    inspector = ProjectInspector(project)

    matches = inspector.search_project_text("TypeError")

    assert [match.model_dump() for match in matches] == [
        {"path": "LoginPage.ets", "line": 1, "excerpt": "const reason = 'TypeError';"}
    ]
    assert "escape.txt" not in inspector.list_project_files()
    with pytest.raises(InspectionBoundaryError, match="escapes"):
        inspector.read_project_file("escape.txt")


def test_business_context_prefers_matching_repository_contract(tmp_path: Path) -> None:
    contract_dir = tmp_path / "harness_Engineering" / "knowledge" / "contracts"
    contract_dir.mkdir(parents=True)
    (contract_dir / "transactions.md").write_text(
        "# Transaction Contract\n订单支付状态必须关联 orderNo。\n",
        encoding="utf-8",
    )
    (tmp_path / "README.md").write_text("# App\n", encoding="utf-8")
    inspector = ProjectInspector(tmp_path)

    documents = inspector.load_business_context("学生订单支付状态有问题")

    assert documents[0].path == "harness_Engineering/knowledge/contracts/transactions.md"
    assert "orderNo" in documents[0].excerpt


@pytest.mark.asyncio
async def test_mcp_server_exposes_and_calls_read_only_tools(tmp_path: Path) -> None:
    (tmp_path / "Index.ets").write_text("@Entry\n@Component\n", encoding="utf-8")
    server = create_mcp_server(tmp_path)

    async with Client(server) as client:
        tools = await client.list_tools()
        names = {tool.name for tool in tools}
        result = await client.call_tool("search_project_text", {"query": "@Entry"})

    assert names == {
        "list_project_files",
        "search_project_text",
        "read_project_file",
        "parse_hilog",
        "load_business_context",
    }
    assert "Index.ets" in str(result)
