"""聊天工作区工具的有界分页协议测试(方案 §5.1/§5.2 在 FunctionToolset 入口的落地)。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.usage import RunUsage

from harmony_agent.domain import Conversation
from harmony_agent.toolsets.chat_workspace import ChatDeps, build_chat_workspace_toolset

LINE_COST = 59  # 每行「行号 + 正文 + 换行」的交付成本


def _write_fixed_width(workspace: Path, name: str, lines: int) -> None:
    workspace.joinpath(name).write_text(
        "".join("x" * (LINE_COST - len(str(n)) - 3) + "\n" for n in range(1, lines + 1)),
        encoding="utf-8",
    )


def _ctx(workspace: Path) -> RunContext[ChatDeps]:
    # 读/搜工具只触碰 conversation.workspace_path,不经过仓库管理器
    deps = ChatDeps(
        conversation=Conversation(workspace_path=str(workspace)),
        repositories=None,  # type: ignore[arg-type]
        conversations=None,  # type: ignore[arg-type]
    )
    return RunContext(deps=deps, model=None, usage=RunUsage())  # type: ignore[arg-type]


async def _call(workspace: Path, name: str, args: dict):
    toolset = build_chat_workspace_toolset()
    ctx = _ctx(workspace)
    tools = await toolset.get_tools(ctx)
    return await toolset.call_tool(name, args, ctx, tools[name])


async def test_chat_read_paginates_by_character_budget_and_continuation_loses_no_line(
    tmp_path: Path,
) -> None:
    """聊天入口同样按字符预算分页:请求 1-200 只容 1-95 时 end_line=95、next_line=96。"""
    _write_fixed_width(tmp_path, "a.ets", 200)

    page = await _call(
        tmp_path,
        "read_project_file",
        {"relative_path": "a.ets", "start_line": 1, "end_line": 200, "max_chars": LINE_COST * 95},
    )

    assert (page["start_line"], page["end_line"]) == (1, 95)
    assert page["truncated"] and page["truncation_reason"] == "character_budget"
    assert page["next_line"] == 96
    assert page["requested_end_line"] == 200 and page["total_lines"] == 200
    assert page["has_more_in_file"]

    rest = await _call(
        tmp_path,
        "read_project_file",
        {
            "relative_path": "a.ets",
            "start_line": page["next_line"],
            "end_line": 200,
            # 余下 105 行超出默认预算,显式提高预算一次读完
            "max_chars": 12_000,
        },
    )
    assert (rest["start_line"], rest["end_line"]) == (96, 200)
    assert not rest["truncated"] and rest["next_line"] is None
    delivered = [
        int(line.split(":", 1)[0])
        for line in (page["content"] + "\n" + rest["content"]).splitlines()
    ]
    assert delivered == list(range(1, 201))


async def test_chat_read_default_budget_is_bounded(tmp_path: Path) -> None:
    """默认预算 6000:不传 max_chars 也不会一次交付整个大区间。"""
    _write_fixed_width(tmp_path, "a.ets", 200)

    page = await _call(tmp_path, "read_project_file", {"relative_path": "a.ets"})

    assert page["truncated"] and page["truncation_reason"] == "character_budget"
    assert len(page["content"]) <= 6000
    assert page["next_line"] == page["end_line"] + 1


async def test_chat_read_edge_cases_raise_actionable_retries(tmp_path: Path) -> None:
    """非法范围、起点超 EOF、预算容不下一行:都转成可行动的 ModelRetry。"""
    tmp_path.joinpath("short.ets").write_text("alpha\nbeta\n", encoding="utf-8")

    with pytest.raises(ModelRetry, match="非法行范围"):
        await _call(
            tmp_path,
            "read_project_file",
            {"relative_path": "short.ets", "start_line": 2, "end_line": 1},
        )
    with pytest.raises(ModelRetry, match="超出文件末尾"):
        await _call(
            tmp_path,
            "read_project_file",
            {"relative_path": "short.ets", "start_line": 10, "end_line": 20},
        )
    with pytest.raises(ModelRetry, match="max_chars"):
        await _call(
            tmp_path,
            "read_project_file",
            {"relative_path": "short.ets", "start_line": 1, "end_line": 2, "max_chars": 3},
        )


async def test_chat_search_returns_page_and_cursor_binds_conditions(tmp_path: Path) -> None:
    """搜索返回 SearchPage;游标续查不漏不重,跨条件复用转成 ModelRetry。"""
    for index in range(15):
        tmp_path.joinpath(f"file{index:02d}.ets").write_text(
            f"// target hit {index}\n", encoding="utf-8"
        )

    first = await _call(tmp_path, "search_project_text", {"query": "target hit"})

    assert len(first["matches"]) == 10 and first["truncated"]
    assert first["next_cursor"]
    assert first["scanned_files"] >= 10 and not first["scan_limit_reached"]

    second = await _call(
        tmp_path,
        "search_project_text",
        {"query": "target hit", "cursor": first["next_cursor"]},
    )
    assert len(second["matches"]) == 5 and not second["truncated"]
    paths = [m["path"] for m in [*first["matches"], *second["matches"]]]
    assert len(paths) == len(set(paths)) == 15

    with pytest.raises(ModelRetry, match="不能跨条件复用"):
        await _call(
            tmp_path,
            "search_project_text",
            {"query": "other", "cursor": first["next_cursor"]},
        )


async def test_chat_search_empty_page_discloses_scope(tmp_path: Path) -> None:
    """无命中页如实披露检索范围,matches 为空但结构完整。"""
    tmp_path.joinpath("a.ets").write_text("nothing here\n", encoding="utf-8")

    page = await _call(tmp_path, "search_project_text", {"query": "absent-term"})

    assert page["matches"] == []
    assert page["scanned_files"] == 1 and not page["scan_limit_reached"]
    assert not page["truncated"] and page["next_cursor"] is None
