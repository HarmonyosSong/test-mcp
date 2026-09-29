from __future__ import annotations

import json

from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from harmony_agent.toolsets.locator_guidance import (
    CodeLocatorRegistry,
    LocatorGuidanceToolset,
)


def test_registry_extracts_locators_and_hints_until_file_read() -> None:
    """从知识文本提取「符号 → 位置」;文件未读时给提示,读过后不再提示。"""
    registry = CodeLocatorRegistry()
    registry.register_text(
        "容器 `XesWebView/src/main/ets/components/webview/WebView.ets:163` 的 "
        "`onShowFileSelector` 未读取 accept;另见 `XesWebview.ets`。"
    )
    # 纯小写常见词不收,否则任何 query 都会误命中
    registry.register_text("设置 `id` 与 `content` 字段,参考 `https://example.com/x.ts`")

    hint = registry.hint_for("onShowFileSelector")
    assert hint is not None and "WebView.ets:163" in hint
    assert registry.hint_for("id") is None
    assert registry.hint_for("完全无关的搜索词") is None

    # 读 1-50 行不覆盖 163 行锚点:仍提示(读过文件头不等于读过锚点)
    registry.mark_read("XesWebView/src/main/ets/components/webview/WebView.ets", 1, 50)
    assert registry.hint_for("onShowFileSelector") is not None
    # 读到覆盖 163 行的区间后才消除;无行号的 XesWebview.ets 锚点未被读过,仍应提示
    registry.mark_read("XesWebView/src/main/ets/components/webview/WebView.ets", 140, 180)
    hint_after = registry.hint_for("onShowFileSelector")
    assert hint_after is not None and "XesWebview.ets" in hint_after
    assert "WebView.ets" not in hint_after


def test_registry_matches_symbol_as_substring_of_query() -> None:
    """query 不必与符号完全相同,包含即可(如搜 'onShowFileSelector 文件')。"""
    registry = CodeLocatorRegistry()
    registry.register_text("`a/b.ets:10` 的 `buildUploadActionList`")
    assert registry.hint_for("buildUploadActionList 的调用方") is not None


async def test_search_hit_with_indexed_symbol_gets_locator_hint() -> None:
    """端到端:知识返回带代码位置后,搜索同一符号时结果附直达提示。

    SearchPage 形态:hint 是页上的独立元数据字段,不混入 matches——
    matches 里只有实际交付的命中,提示不是观测。
    """
    knowledge = FunctionToolset()
    workspace = FunctionToolset()

    @knowledge.tool_plain
    def lookup_issue(query: str) -> dict:
        return {
            "documents": [
                {
                    "name": "error-book-upload-file-types",
                    "body": "容器 `XesWebView/src/main/ets/components/webview/WebView.ets:163`"
                    " 的 `onShowFileSelector` 未读取 accept",
                }
            ]
        }

    @workspace.tool_plain
    def search_project_text(query: str) -> dict:
        return {
            "query": query,
            "file_glob": "**/*",
            "matches": [
                {
                    "path": "XesWebView/src/main/ets/components/webview/WebView.ets",
                    "line": 163,
                    "excerpt": ".onShowFileSelector((event) => ...",
                }
            ],
            "truncated": False,
            "scanned_files": 1,
            "scan_limit_reached": False,
            "next_cursor": None,
        }

    registry = CodeLocatorRegistry()
    steps = iter(["lookup", "search"])
    tool_returns: list[str] = []

    def respond(messages, info):
        for message in reversed(messages):
            for part in getattr(message, "parts", []):
                if part.__class__.__name__ == "ToolReturnPart":
                    tool_returns.append(json.dumps(part.content, ensure_ascii=False, default=str))
                    break
            else:
                continue
            break
        step = next(steps, None)
        if step == "lookup":
            return ModelResponse(parts=[ToolCallPart("lookup_issue", {"query": "错题本"})])
        if step == "search":
            return ModelResponse(
                parts=[ToolCallPart("search_project_text", {"query": "onShowFileSelector"})]
            )
        return ModelResponse(parts=[TextPart("done")])

    agent = Agent(
        FunctionModel(respond),
        retries=0,
        toolsets=[
            LocatorGuidanceToolset(knowledge, registry=registry),
            LocatorGuidanceToolset(workspace, registry=registry),
        ],
    )
    result = await agent.run("排查")
    assert result.output == "done"
    assert len(tool_returns) == 2
    assert "locator_hint" not in tool_returns[0]
    page = json.loads(tool_returns[1])
    assert "WebView.ets:163" in page["locator_hint"]
    assert all("locator_hint" not in match for match in page["matches"])


async def test_read_marks_actual_delivered_range_not_requested_range() -> None:
    """已读标记按实际交付区间:字符预算只交付 1-95 时,163 行锚点提示不能消除。"""
    workspace = FunctionToolset()

    @workspace.tool_plain
    def read_project_file(relative_path: str) -> dict:
        # 请求 1-200 但预算只交付 1-95 的分页页
        return {
            "path": relative_path,
            "start_line": 1,
            "end_line": 95,
            "requested_end_line": 200,
            "total_lines": 430,
            "content": "1: ...",
            "truncated": True,
            "next_line": 96,
            "has_more_in_file": True,
            "truncation_reason": "character_budget",
        }

    registry = CodeLocatorRegistry()
    registry.register_text(
        "容器 `XesWebView/src/main/ets/components/webview/WebView.ets:163` 的 `onShowFileSelector`"
    )
    steps = iter(["read"])

    def respond(messages, info):
        if next(steps, None) == "read":
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "read_project_file",
                        {"relative_path": "XesWebView/src/main/ets/components/webview/WebView.ets"},
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("done")])

    agent = Agent(
        FunctionModel(respond),
        retries=0,
        toolsets=[LocatorGuidanceToolset(workspace, registry=registry)],
    )
    await agent.run("排查")
    path = "XesWebView/src/main/ets/components/webview/WebView.ets"
    # 只交付到 95 行:记 (1, 95) 而非请求的 (1, 200),163 行锚点的直达提示保留
    assert registry.read_ranges[path] == [(1, 95)]
    assert registry.hint_for("onShowFileSelector") is not None
