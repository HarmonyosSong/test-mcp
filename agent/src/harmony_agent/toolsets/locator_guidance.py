"""知识索引直达引导:把「按知识给出的代码位置直接核实」从提示词变成机制。

知识条目正文常带代码位置(`WebView.ets:163`、`onShowFileSelector`),但模型拿到
索引后仍习惯用 search_project_text 重新发现同一位置(实测一轮浪费 6-8 次调用)。
本层从知识工具返回里提取「符号 → 位置」注册表;后续搜索命中已索引符号且对应
文件尚未读过时,在结果上附重定向提示。不拦截调用——只让提示每次必现,
不被长上下文稀释(这正是纯提示词条款做不到的)。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.toolsets import WrapperToolset
from pydantic_ai.toolsets.abstract import ToolsetTool

# 返回正文里可提取代码位置的知识类工具。
_KNOWLEDGE_TOOLS = {
    "lookup_issue",
    "get_knowledge_entry",
    "search_knowledge",
    "resolve_external_knowledge",
    "read_external_knowledge",
}

# 反引号包裹的代码引用:`XesWebView/.../WebView.ets:163` 或 `onShowFileSelector`。
_BACKTICK = re.compile(r"`([^`\s]+)`")
# 文件路径:含 / 且有源码扩展名,可带 :行号 或 :起-止 区间。
_PATH = re.compile(r"^([\w./-]+\.(?:ets|ts|json5?))(?::(\d+))?(?:-\d+)?$")
# 符号名:至少含一个大写字母或下划线——排掉 id/path/name 这类纯小写常见词,
# 否则任何 query 都会误命中。
_SYMBOL = re.compile(r"^(?=.*[A-Z_])[A-Za-z_$][\w$]{3,40}$")


@dataclass(frozen=True, slots=True)
class Locator:
    path: str
    line: int | None


@dataclass
class CodeLocatorRegistry:
    """本轮会话的索引注册表:符号 → 知识条目给出的位置;以及已读文件的行区间。"""

    symbol_to_locators: dict[str, list[Locator]] = field(default_factory=dict)
    # 按行区间记已读:读 1-50 行不能消除 163 行处的锚点提示。
    read_ranges: dict[str, list[tuple[int, int]]] = field(default_factory=dict)

    def mark_read(self, path: str, start_line: int, end_line: int) -> None:
        self.read_ranges.setdefault(path, []).append((start_line, max(start_line, end_line)))

    def _covered(self, locator: Locator) -> bool:
        ranges = self.read_ranges.get(locator.path)
        if not ranges:
            return False
        if locator.line is None:
            return True  # 无行号锚点:文件读过任意区间即视为覆盖
        return any(start <= locator.line <= end for start, end in ranges)

    def register_text(self, text: str) -> None:
        paths: list[Locator] = []
        symbols: list[str] = []
        for token in _BACKTICK.findall(text):
            match = _PATH.match(token)
            if match:
                line = match.group(2)
                paths.append(Locator(match.group(1), int(line) if line else None))
            elif _SYMBOL.match(token):
                symbols.append(token)
        # 条目级关联:一条知识通常只讲 1-2 个文件,符号与同条目共现的文件关联即可。
        for symbol in symbols:
            bucket = self.symbol_to_locators.setdefault(symbol, [])
            for locator in paths:
                if locator not in bucket:
                    bucket.append(locator)

    def hint_for(self, query: str) -> str | None:
        folded = query.strip().casefold()
        if not folded:
            return None
        hits: list[str] = []
        for symbol, locators in self.symbol_to_locators.items():
            if symbol.casefold() not in folded:
                continue
            # 锚点行已被读取覆盖才消除提示:条目常同时提到新旧两套实现,
            # 读过其一的对应行区间即视为已按索引核实。
            unread = [locator for locator in locators if not self._covered(locator)]
            if locators and not unread:
                continue
            for locator in unread:
                where = f"{locator.path}:{locator.line}" if locator.line else locator.path
                hits.append(f"`{symbol}` 已索引于 {where}")
        if not hits:
            return None
        return (
            "知识索引已给出位置:"
            + ";".join(hits[:3])
            + "。建议直接 read_project_file 该位置 ±60 行核实,无需重新搜索定位。"
        )


@dataclass
class LocatorGuidanceToolset(WrapperToolset[Any]):
    """维护索引注册表,并给「重新搜索已索引符号」的调用附直达提示。"""

    registry: CodeLocatorRegistry

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: Any, tool: ToolsetTool[Any]
    ) -> Any:
        result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
        if name in _KNOWLEDGE_TOOLS:
            self.registry.register_text(json.dumps(result, ensure_ascii=False, default=str))
            return result
        if name == "read_project_file":
            path = tool_args.get("relative_path")
            if isinstance(path, str):
                # end_line 缺省时与 chat_workspace 的工具默认(200)保持一致。
                start = int(tool_args.get("start_line") or 1)
                end = int(tool_args.get("end_line") or start + 199)
                self.registry.mark_read(path, start, end)
            return result
        if name == "search_project_text":
            hint = self.registry.hint_for(str(tool_args.get("query", "")))
            if hint is None:
                return result
            # 列表结果追加一项而不是包层:外层 evidence ledger 依赖列表结构
            # 逐行登记观测,包层会让证据丢失;hint 行无 content/excerpt,不会被误登记。
            if isinstance(result, list):
                return [*result, {"locator_hint": hint}]
            if isinstance(result, dict):
                return {**result, "locator_hint": hint}
            return {"result": result, "locator_hint": hint}
        return result
