from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from harmony_repo_mcp.inspector import InspectionBoundaryError, ProjectInspector
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.toolsets import FunctionToolset

from ..domain import Conversation

if TYPE_CHECKING:
    from ..repositories.conversations import ConversationRepository
    from ..repositories.git import RepositoryManager


@dataclass
class ChatDeps:
    """聊天轮的依赖：会话对象（可被 bind_repository 就地更新）与持久化入口。"""

    conversation: Conversation
    repositories: RepositoryManager
    conversations: ConversationRepository


async def _require_inspector(ctx: RunContext[ChatDeps]) -> ProjectInspector:
    """懒解析工作区：未绑定时引导模型先 bind_repository，而不是直接失败。"""
    workspace = ctx.deps.conversation.workspace_path
    if not workspace:
        records = await ctx.deps.repositories.list()
        available = ", ".join(f"{item.name}({item.url})" for item in records) or "（无）"
        raise ModelRetry(
            "当前会话尚未绑定代码仓库，无法访问工作区文件。"
            f"请先调用 bind_repository 绑定已登记的仓库之一：{available}。"
        )
    return ProjectInspector(Path(workspace))


def build_chat_workspace_toolset() -> FunctionToolset[ChatDeps]:
    """聊天路径的工作区工具集：始终挂载，绑定点由 bind_repository 工具完成。

    与诊断案例路径的差异：案例在创建时固定快照并挂载 MCP 工具集；
    聊天则允许模型在同一轮里先 bind_repository 再立即检索代码。
    """

    toolset: FunctionToolset[ChatDeps] = FunctionToolset()

    @toolset.tool
    async def bind_repository(
        ctx: RunContext[ChatDeps],
        name_or_url: str,
        branch: str | None = None,
    ) -> str:
        """把当前会话绑定到一个已登记的业务仓库（创建该分支的只读快照）。

        当需要查阅项目代码时会话必须已绑定仓库。只能绑定服务端已登记的仓库，
        不能绑定任意 URL。branch 为空时使用仓库默认分支；用户明确提到分支或
        版本号（如 releaseV/20260825）时应传入该分支。
        """
        deps = ctx.deps
        needle = name_or_url.strip().lower()
        records = await deps.repositories.list()
        match = next(
            (item for item in records if needle in item.name.lower() or needle in item.url.lower()),
            None,
        )
        if match is None:
            available = ", ".join(f"{item.name}({item.url})" for item in records) or "（无）"
            raise ModelRetry(
                f"未找到登记的仓库 '{name_or_url}'。可用仓库：{available}。"
                "如需新仓库，请用户先在仓库设置中登记。"
            )
        ref = (branch or "").strip() or match.default_branch
        snapshot = await deps.repositories.prepare_snapshot(match.id, ref)

        conversation = deps.conversation
        conversation.workspace_path = snapshot.workspace_path
        conversation.repository_id = match.id
        conversation.repository_name = match.name
        conversation.requested_ref = ref
        conversation.resolved_commit = snapshot.resolved_commit
        await deps.conversations.save(conversation)
        return (
            f"已绑定仓库 {match.name} @ {ref}"
            f"（commit {snapshot.resolved_commit[:12]}），只读快照已就绪，"
            "现在可以使用 list_project_files / search_project_text / read_project_file。"
        )

    @toolset.tool
    async def list_project_files(
        ctx: RunContext[ChatDeps], pattern: str = "**/*", limit: int = 100
    ) -> list[str]:
        """列出已绑定工作区内匹配的文本文件（相对路径）。"""
        inspector = await _require_inspector(ctx)
        return inspector.list_project_files(pattern, limit)

    @toolset.tool
    async def search_project_text(
        ctx: RunContext[ChatDeps],
        query: str,
        file_glob: str = "**/*",
        limit: int = 50,
    ) -> list[dict]:
        """在已绑定工作区内做大小写不敏感的字面文本搜索。"""
        inspector = await _require_inspector(ctx)
        matches = inspector.search_project_text(query, file_glob, limit)
        return [match.model_dump(mode="json") for match in matches]

    @toolset.tool
    async def read_project_file(
        ctx: RunContext[ChatDeps],
        relative_path: str,
        start_line: int = 1,
        end_line: int = 200,
    ) -> dict:
        """读取已绑定工作区内单个文件的指定行范围。"""
        inspector = await _require_inspector(ctx)
        try:
            content = inspector.read_project_file(relative_path, start_line, end_line)
        except InspectionBoundaryError as exc:
            raise ModelRetry(f"文件不可读（不存在、越界或类型不允许）：{exc}") from exc
        return content.model_dump(mode="json")

    @toolset.tool
    async def load_business_context(
        ctx: RunContext[ChatDeps], query: str, limit: int = 8
    ) -> list[dict]:
        """按问题关键词加载仓库内的业务上下文文档（Skill、契约、模块参考）。"""
        inspector = await _require_inspector(ctx)
        documents = inspector.load_business_context(query, limit)
        return [document.model_dump(mode="json") for document in documents]

    @toolset.tool_plain
    def parse_hilog(log_text: str, limit: int = 50) -> dict:
        """解析粘贴的 hilog 日志文本，提取错误、告警与关键事件。不依赖工作区。"""
        summary = ProjectInspector.parse_hilog(log_text, limit)
        return summary.model_dump(mode="json")

    return toolset
