from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from time import perf_counter
from typing import Any
from uuid import uuid4

from pydantic_ai import Agent, ModelMessagesTypeAdapter
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    RetryPromptPart,
    TextPartDelta,
)
from pydantic_ai.models import Model
from pydantic_ai.run import AgentRunResultEvent

from ..domain import Conversation, ToolEvent, trim_messages_state
from ..repositories import ConversationRepository, RepositoryManager
from ..runtimes.model_gateway import ModelGateway
from ..skill_runtime.registry import SkillRegistry
from ..toolsets import (
    build_chat_repository_toolset,
    build_chat_workspace_toolset,
    build_skill_toolset,
)
from ..toolsets.chat_workspace import ChatDeps
from .prompts import build_chat_instructions


class ModelNotConfiguredError(RuntimeError):
    """聊天与案例提取都要求先配置模型，demo 模式不提供对话能力。"""


# ---- 流式事件（agent 包内部协议，不依赖 ag_ui，由 server 层翻译为 AG-UI 帧） ----


@dataclass(frozen=True)
class TextDelta:
    delta: str


@dataclass(frozen=True)
class ToolStarted:
    event: ToolEvent


@dataclass(frozen=True)
class ToolFinished:
    event: ToolEvent


@dataclass(frozen=True)
class Completed:
    text: str
    messages_state: list[dict]
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class Failed:
    error: str


ChatStreamEvent = TextDelta | ToolStarted | ToolFinished | Completed | Failed


def _truncate(value: str, limit: int = 500) -> str:
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _render_arguments(args: Any) -> str:
    if isinstance(args, str):
        return _truncate(args)
    try:
        return _truncate(json.dumps(args, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return _truncate(str(args))


def _render_result(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return _truncate(content)
    try:
        return _truncate(json.dumps(content, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return _truncate(str(content))


class HarmonyChatAgent:
    """多轮聊天 Agent：逐字流式输出 + 工具/Skill 调用步骤可见。"""

    def __init__(
        self,
        registry: SkillRegistry,
        model_gateway: ModelGateway,
        repositories: RepositoryManager | None = None,
        conversations: ConversationRepository | None = None,
    ) -> None:
        self.registry = registry
        self.model_gateway = model_gateway
        self.repositories = repositories
        self.conversations = conversations
        # 测试缝：注入 TestModel 等离线模型，避免为 ModelGateway 开后门。
        self.model_override: Model | None = None

    async def stream_turn(
        self,
        conversation: Conversation,
        content: str,
    ) -> AsyncIterator[ChatStreamEvent]:
        model = self.model_override or await self.model_gateway.get_model_for(
            conversation.model_override
        )
        if model is None:
            raise ModelNotConfiguredError("聊天需要先在模型设置中配置模型")

        history = (
            ModelMessagesTypeAdapter.validate_python(conversation.messages_state)
            if conversation.messages_state
            else None
        )
        catalog = "\n".join(f"- {skill.name}: {skill.description}" for skill in self.registry.all())

        # 有仓储依赖时走「始终挂载 + bind_repository 懒绑定」工具集；
        # 否则退化为仅在会话已绑定工作区时挂载只读 MCP 工具（兼容旧构造）。
        deps: ChatDeps | None = None
        toolsets: list[Any] = []
        if self.repositories is not None and self.conversations is not None:
            deps = ChatDeps(
                conversation=conversation,
                repositories=self.repositories,
                conversations=self.conversations,
            )
            toolsets.append(build_chat_workspace_toolset())
        else:
            repository_toolset = build_chat_repository_toolset(conversation.workspace_path)
            if repository_toolset is not None:
                toolsets.append(repository_toolset)
        toolsets.append(build_skill_toolset(self.registry))

        agent = Agent(
            model,
            output_type=str,
            instructions=build_chat_instructions(catalog),
            toolsets=toolsets,
            defer_model_check=True,
            retries=2,
            deps_type=ChatDeps if deps is not None else None,
        )

        collected: list[str] = []
        inflight: dict[str, tuple[ToolEvent, float]] = {}
        final_text = ""
        all_messages: list[Any] = []
        input_tokens: int | None = None
        output_tokens: int | None = None
        try:
            async with agent.run_stream_events(
                content, message_history=history, deps=deps
            ) as events:
                async for event in events:
                    if isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        collected.append(event.delta.content_delta)
                        yield TextDelta(event.delta.content_delta)
                    elif isinstance(event, FunctionToolCallEvent):
                        started = perf_counter()
                        tool_event = ToolEvent(
                            tool=event.part.tool_name,
                            status="running",
                            summary=f"调用 {event.part.tool_name}",
                            arguments_summary=_render_arguments(event.part.args),
                        )
                        inflight[event.part.tool_call_id] = (tool_event, started)
                        yield ToolStarted(tool_event)
                    elif isinstance(event, FunctionToolResultEvent):
                        part = event.part
                        failed = isinstance(part, RetryPromptPart)
                        entry = inflight.pop(part.tool_call_id, None)
                        duration_ms = (
                            max(1, round((perf_counter() - entry[1]) * 1_000)) if entry else None
                        )
                        tool_name = getattr(part, "tool_name", None) or (
                            entry[0].tool if entry else "unknown"
                        )
                        status = "failed" if failed else "completed"
                        done = ToolEvent(
                            id=entry[0].id if entry else f"tool-{uuid4().hex[:8]}",
                            tool=tool_name,
                            status=status,
                            summary=(f"{tool_name} 调用失败" if failed else f"{tool_name} 调用完成")
                            + (f"，耗时 {duration_ms} ms" if duration_ms else ""),
                            arguments_summary=entry[0].arguments_summary if entry else None,
                            result_summary=_render_result(getattr(part, "content", None)),
                            duration_ms=duration_ms,
                        )
                        yield ToolFinished(done)
                    elif isinstance(event, AgentRunResultEvent):
                        output = event.result.output
                        final_text = output if isinstance(output, str) else str(output)
                        all_messages = list(event.result.all_messages())
                        usage = event.result.usage
                        input_tokens = usage.input_tokens
                        output_tokens = usage.output_tokens
        except Exception as exc:  # noqa: BLE001 —— 任何失败都要如实转成 Failed 事件
            yield Failed(error=f"{type(exc).__name__}: {exc}")
            return

        messages_state = (
            ModelMessagesTypeAdapter.dump_python(all_messages, mode="json") if all_messages else []
        )
        yield Completed(
            text=final_text or "".join(collected),
            messages_state=trim_messages_state(messages_state),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
