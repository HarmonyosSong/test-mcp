from pathlib import Path

import pytest
from fastmcp import Client

from harmony_repo_mcp import InspectionBoundaryError, ProjectInspector, create_mcp_server
from harmony_repo_mcp.schemas import MAX_READ_CHARS


def _fixed_width_file(path: Path, lines: int, line_cost: int) -> None:
    """生成每行「行号 + 正文 + 换行」交付成本恒为 line_cost 的测试文件。"""
    content = "".join(
        "x" * (line_cost - len(str(number)) - 3) + "\n" for number in range(1, lines + 1)
    )
    path.write_text(content, encoding="utf-8")


def test_inspector_searches_text_and_blocks_symlink_escape(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    page = project / "LoginPage.ets"
    page.write_text("const reason = 'TypeError';\n", encoding="utf-8")
    outside = tmp_path / "secret.txt"
    outside.write_text("do not read", encoding="utf-8")
    (project / "escape.txt").symlink_to(outside)
    inspector = ProjectInspector(project)

    result = inspector.search_project_text("TypeError")

    assert [match.model_dump() for match in result.matches] == [
        {"path": "LoginPage.ets", "line": 1, "excerpt": "const reason = 'TypeError';"}
    ]
    assert not result.truncated and result.next_cursor is None
    assert not result.scan_limit_reached and result.scanned_files == 1
    assert "escape.txt" not in inspector.list_project_files()
    with pytest.raises(InspectionBoundaryError, match="escapes"):
        inspector.read_project_file("escape.txt")


def test_read_paginates_by_character_budget_and_continuation_loses_no_line(
    tmp_path: Path,
) -> None:
    """字符预算只容 1-95 时:end_line=95、next_line=96;续读不漏行、不重行。"""
    project = tmp_path / "project"
    project.mkdir()
    line_cost = 59
    _fixed_width_file(project / "a.ets", lines=200, line_cost=line_cost)
    inspector = ProjectInspector(project)

    page = inspector.read_project_file("a.ets", 1, 200, max_chars=line_cost * 95)

    assert (page.start_line, page.end_line) == (1, 95)
    assert page.truncated and page.truncation_reason == "character_budget"
    assert page.next_line == 96
    assert page.requested_end_line == 200 and page.total_lines == 200
    assert page.has_more_in_file

    rest = inspector.read_project_file("a.ets", page.next_line, 200, max_chars=MAX_READ_CHARS)

    assert (rest.start_line, rest.end_line) == (96, 200)
    assert not rest.truncated and rest.next_line is None
    assert not rest.has_more_in_file
    delivered = [
        int(line.split(":", 1)[0]) for line in (page.content + "\n" + rest.content).splitlines()
    ]
    assert delivered == list(range(1, 201))


def test_read_defaults_to_bounded_budget(tmp_path: Path) -> None:
    """默认预算 6000:请求 1-200 的等宽行文件会在预算处截断并给出续读游标。"""
    project = tmp_path / "project"
    project.mkdir()
    line_cost = 59
    _fixed_width_file(project / "a.ets", lines=200, line_cost=line_cost)
    inspector = ProjectInspector(project)

    page = inspector.read_project_file("a.ets", 1, 200)

    assert page.truncated and page.truncation_reason == "character_budget"
    assert page.end_line == 6000 // line_cost
    assert page.next_line == page.end_line + 1
    assert len(page.content) <= 6000


def test_read_line_too_long_is_disclosed_and_cursor_moves_forward(tmp_path: Path) -> None:
    """单行超过硬上限:结构化 line_too_long 披露并越过该行,不出现原地游标循环。"""
    project = tmp_path / "project"
    project.mkdir()
    rows = ["normal"] * 5
    rows[2] = "y" * (MAX_READ_CHARS + 100)
    (project / "b.ets").write_text("\n".join(rows) + "\n", encoding="utf-8")
    inspector = ProjectInspector(project)

    page = inspector.read_project_file("b.ets", 1, 5, max_chars=MAX_READ_CHARS)

    assert (page.start_line, page.end_line) == (1, 2)
    assert page.truncated and page.truncation_reason == "line_too_long"
    assert page.skipped_lines == [3]
    assert page.next_line == 4  # 越过超长行,不是停在 3

    rest = inspector.read_project_file("b.ets", page.next_line, 5)
    assert (rest.start_line, rest.end_line) == (4, 5)
    assert not rest.truncated and rest.next_line is None

    # 起点本身就是超长行:空交付但游标越过,绝不返回 next_line == start_line
    first = inspector.read_project_file("b.ets", 3, 5)
    assert first.content == "" and first.end_line == 2
    assert first.skipped_lines == [3] and first.next_line == 4

    # 超长行恰好在请求范围末尾:范围已清点完毕,不再给续读游标
    last = inspector.read_project_file("b.ets", 3, 3)
    assert last.skipped_lines == [3] and last.next_line is None and last.truncated


def test_read_edge_cases_are_explicit(tmp_path: Path) -> None:
    """空文件、起点超 EOF、非法范围、预算容不下一行:行为明确,无伪造完整页。"""
    project = tmp_path / "project"
    project.mkdir()
    (project / "empty.ets").write_text("", encoding="utf-8")
    (project / "short.ets").write_text("alpha\nbeta\n", encoding="utf-8")
    inspector = ProjectInspector(project)

    empty = inspector.read_project_file("empty.ets", 1, 200)
    assert empty.total_lines == 0 and empty.content == ""
    assert empty.end_line == empty.start_line - 1  # 空页标记,不标成正常页
    assert not empty.truncated and empty.next_line is None
    assert not empty.has_more_in_file

    with pytest.raises(InspectionBoundaryError, match="超出文件末尾"):
        inspector.read_project_file("short.ets", 10, 20)
    with pytest.raises(ValueError, match="非法行范围"):
        inspector.read_project_file("short.ets", 2, 1)
    with pytest.raises(ValueError, match="max_chars"):
        inspector.read_project_file("short.ets", 1, 2, max_chars=3)


def test_read_line_range_limit_is_disclosed(tmp_path: Path) -> None:
    """请求超过 400 行窗口:窗口内全量交付仍标 truncated,reason=line_range_limit。"""
    project = tmp_path / "project"
    project.mkdir()
    (project / "long.ets").write_text("".join(f"l{n}\n" for n in range(1, 501)), encoding="utf-8")
    inspector = ProjectInspector(project)

    page = inspector.read_project_file("long.ets", 1, 1000, max_chars=MAX_READ_CHARS)

    assert (page.start_line, page.end_line) == (1, 400)
    assert page.truncated and page.truncation_reason == "line_range_limit"
    assert page.next_line == 401 and page.requested_end_line == 1000
    assert page.has_more_in_file


def test_search_pages_with_cursor_bound_to_conditions(tmp_path: Path) -> None:
    """搜索有界分页:游标续查不漏不重;跨 query/file_glob/快照复用被拒绝。"""
    project = tmp_path / "project"
    project.mkdir()
    for index in range(15):
        (project / f"file{index:02d}.ets").write_text(f"// target hit {index}\n", encoding="utf-8")
    inspector = ProjectInspector(project)

    first = inspector.search_project_text("target hit")

    assert len(first.matches) == 10 and first.truncated
    assert first.next_cursor is not None
    assert [match.path for match in first.matches] == sorted(match.path for match in first.matches)

    second = inspector.search_project_text("target hit", cursor=first.next_cursor)

    assert len(second.matches) == 5 and not second.truncated
    assert second.next_cursor is None
    paths = [match.path for match in [*first.matches, *second.matches]]
    assert len(paths) == len(set(paths)) == 15

    # 游标绑定 query/file_glob/快照:跨条件复用显式报错
    with pytest.raises(ValueError, match="不能跨条件复用"):
        inspector.search_project_text("other", cursor=first.next_cursor)
    with pytest.raises(ValueError, match="不能跨条件复用"):
        inspector.search_project_text("target hit", "*.ts", cursor=first.next_cursor)
    other = ProjectInspector(tmp_path)
    with pytest.raises(ValueError, match="另一个工作区快照"):
        other.search_project_text("target hit", cursor=first.next_cursor)
    with pytest.raises(ValueError, match="无法解析"):
        inspector.search_project_text("target hit", cursor="not-a-cursor")


def test_search_discloses_scan_limit_and_empty_page(tmp_path: Path) -> None:
    """达到 max_search_files 必须披露;局部无命中不得被误当全仓无命中。"""
    project = tmp_path / "project"
    project.mkdir()
    for index in range(5):
        (project / f"f{index}.ets").write_text("hit\n", encoding="utf-8")
    inspector = ProjectInspector(project, max_search_files=3)

    page = inspector.search_project_text("hit")

    assert page.scan_limit_reached and page.scanned_files == 3
    assert len(page.matches) == 3

    none = inspector.search_project_text("absent-term")
    assert none.matches == [] and none.scan_limit_reached


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
        read = await client.call_tool(
            "read_project_file",
            {"relative_path": "Index.ets", "start_line": 1, "end_line": 10, "max_chars": 6000},
        )

    assert names == {
        "list_project_files",
        "search_project_text",
        "read_project_file",
        "parse_hilog",
        "load_business_context",
    }
    assert "Index.ets" in str(result)
    assert "matches" in str(result)
    assert "next_line" in str(read)
