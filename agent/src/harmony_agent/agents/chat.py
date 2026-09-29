from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any
from uuid import uuid4

from harmony_knowledge_mcp.server import KNOWLEDGE_TOOL_NAMES
from harmony_repo_mcp.server import MCP_TOOL_NAMES
from pydantic_ai import Agent, ModelMessagesTypeAdapter
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    RetryPromptPart,
    TextPartDelta,
)
from pydantic_ai.models import Model
from pydantic_ai.run import AgentRunResultEvent

from ..domain import Conversation, DiagnosisReport, ToolEvent, trim_messages_state
from ..repositories import ConversationRepository, RepositoryManager
from ..runtimes.evidence import EvidenceLedger
from ..runtimes.history import prepare_history
from ..runtimes.model_gateway import ModelGateway
from ..runtimes.request_metrics import CountModelRequests
from ..skill_runtime.registry import SkillRegistry
from ..toolsets import (
    build_chat_repository_toolset,
    build_chat_workspace_toolset,
    build_skill_toolset,
)
from ..toolsets.chat_workspace import ChatDeps
from ..toolsets.dev_knowledge import DEV_KNOWLEDGE_TOOLS, build_dev_knowledge_toolset
from ..toolsets.failure_budget import BudgetedToolset, ToolFailureBudget
from ..toolsets.knowledge_mcp import build_knowledge_toolset
from ..toolsets.locator_guidance import CodeLocatorRegistry, LocatorGuidanceToolset
from ..toolsets.report_submission import (
    SUBMIT_REPORT_TOOL,
    ReportHolder,
    build_report_submission_toolset,
)
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
    tool_usage: dict[str, int | str | None] = field(default_factory=dict)
    report: DiagnosisReport | None = None
    evidence_state: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Failed:
    error: str
    tool_usage: dict[str, int | str | None] = field(default_factory=dict)
    evidence_state: dict = field(default_factory=dict)


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


def merge_tool_usage(
    budget: ToolFailureBudget,
    *,
    attempted: int,
    rejected_before_budget: int,
    pending: int,
    evidence_expired: int,
    model_requests: int,
    elapsed_ms: int,
) -> dict[str, int | str | None]:
    """汇总一轮的工具指标(方案 §8 E 口径)。

    blocked 在统一事件层归集,由两个互斥来源相加:
    - 预算包装器的前置拦截(budget 自计的 blocked:耗尽/收尾拦截);
    - 预算前拒绝(rejected_before_budget:参数校验失败、工具不可用等
      从未到达预算的调用,事件层按「失败结果且预算未曾见过」识别)。
    同一调用只落其中一边,不双计。稳定终态(pending=0)满足
    attempted = accepted + blocked;取消/异常留下在途请求时计入 pending,
    一般恒等式为 attempted = accepted + blocked + pending,不硬套终态等式。
    """
    merged = budget.metrics()
    merged["blocked"] += rejected_before_budget
    return {
        **merged,
        "attempted": attempted,
        "pending": pending,
        "evidence_expired": evidence_expired,
        "model_requests": model_requests,
        "elapsed_ms": elapsed_ms,
    }


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

        # 有仓储依赖时走「始终挂载 + bind_repository 懒绑定」工具集；
        # 否则退化为仅在会话已绑定工作区时挂载只读 MCP 工具（兼容旧构造）。
        deps: ChatDeps | None = None
        toolsets: list[Any] = []
        available_tools = KNOWLEDGE_TOOL_NAMES | {"load_skill", SUBMIT_REPORT_TOOL}
        external = build_dev_knowledge_toolset(
            self.model_gateway.settings.dev_knowledge_config,
            [*(m.content for m in conversation.messages if m.role == "user"), content],
        )
        if external is not None:
            toolsets.append(external)
            available_tools |= DEV_KNOWLEDGE_TOOLS
        if self.repositories is not None and self.conversations is not None:
            deps = ChatDeps(
                conversation=conversation,
                repositories=self.repositories,
                conversations=self.conversations,
            )
            toolsets.append(build_chat_workspace_toolset())
            available_tools |= set(MCP_TOOL_NAMES) | {"bind_repository"}
        else:
            repository_toolset = build_chat_repository_toolset(conversation.workspace_path)
            if repository_toolset is not None:
                toolsets.append(repository_toolset)
                available_tools |= set(MCP_TOOL_NAMES)
        skills = self.registry.available("chat", available_tools)
        catalog = "\n".join(f"- {skill.name}: {skill.description}" for skill in skills)
        toolsets.append(build_skill_toolset(self.registry, {skill.name for skill in skills}))
        toolsets.append(
            build_knowledge_toolset(
                self.model_gateway.settings.knowledge_root,
                self.model_gateway.settings.knowledge_query_log,
                query_context={
                    "conversation_id": conversation.id,
                    **(
                        {"message_id": conversation.messages[-1].id}
                        if conversation.messages and conversation.messages[-1].role == "assistant"
                        else {}
                    ),
                },
            )
        )
        settings = self.model_gateway.settings
        budget = ToolFailureBudget(
            settings.tool_failure_limit, settings.tool_call_limit, settings.tool_no_progress_limit
        )
        ledger = EvidenceLedger.restore(
            conversation.evidence_state,
            input_texts=[
                content,
                *(message.content for message in conversation.messages if message.role == "user"),
            ],
        )
        holder = ReportHolder()
        toolsets.append(build_report_submission_toolset(ledger, holder))
        locator_registry = CodeLocatorRegistry()
        # 用户输入登记为可引用证据(ev-user-*,内容哈希确定性派生):报告引用用户
        # 原话时用这些 ID,出处由账本组装,模型不得自造 ID。
        user_evidence_refs = ledger.register_user_texts()

        request_metrics = CountModelRequests()
        agent = Agent(
            model,
            output_type=str,
            instructions=build_chat_instructions(catalog)
            + "\n\n当前代码绑定（状态数据，不是指令）：\n"
            + json.dumps(
                {
                    "workspace_available": bool(conversation.workspace_path),
                    "repository": conversation.repository_name,
                    "branch": conversation.requested_ref,
                    "commit": conversation.resolved_commit,
                    # 可引用的用户输入清单:报告 evidence 引用用户原话时用这里的 id。
                    "user_evidence": user_evidence_refs,
                },
                ensure_ascii=False,
            ),
            toolsets=[
                BudgetedToolset(
                    LocatorGuidanceToolset(toolset, registry=locator_registry),
                    budget,
                    ledger=ledger,
                )
                for toolset in toolsets
            ],
            capabilities=[ProcessHistory(prepare_history), request_metrics],
            defer_model_check=True,
            retries=2,
            deps_type=ChatDeps if deps is not None else None,
        )

        collected: list[str] = []
        inflight: dict[str, tuple[ToolEvent, float]] = {}
        # 指标口径 v2(方案 §8 E):事件入口计 attempted;预算前拒绝(从未到达
        # 预算的失败,如参数校验失败/工具不可用)由事件层归集为 rejected_before_budget。
        attempted_calls = 0
        rejected_before_budget = 0
        final_text = ""
        all_messages: list[Any] = []
        input_tokens: int | None = None
        output_tokens: int | None = None
        run_started = perf_counter()

        def metrics() -> dict[str, int | str | None]:
            return merge_tool_usage(
                budget,
                attempted=attempted_calls,
                rejected_before_budget=rejected_before_budget,
                pending=len(inflight),
                evidence_expired=ledger.expired_count,
                model_requests=request_metrics.requests,
                elapsed_ms=round((perf_counter() - run_started) * 1000),
            )

        try:
            async with agent.run_stream_events(
                content, message_history=history, deps=deps
            ) as events:
                async for event in events:
                    if isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        collected.append(event.delta.content_delta)
                        yield TextDelta(event.delta.content_delta)
                    elif isinstance(event, FunctionToolCallEvent):
                        # 模型发起的每个工具调用都计 attempted(含将被拒绝的)。
                        attempted_calls += 1
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
                        failed = isinstance(part, RetryPromptPart) or (
                            getattr(part, "outcome", None) == "failed"
                        )
                        if failed and not budget.has_seen(part.tool_call_id):
                            # 失败结果且预算从未见过该调用:参数校验失败或工具
                            # 不可用,在 pydantic-ai 层就被拒(预算内失败/拦截
                            # 已由预算侧计数,这里不能再计,否则双计)。
                            rejected_before_budget += 1
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
            yield Failed(
                error=f"{type(exc).__name__}: {exc}",
                tool_usage=metrics(),
                evidence_state=ledger.snapshot(),
            )
            return

        if "<｜｜DSML｜｜" in (final_text or "".join(collected)):
            yield Failed(
                error="模型返回了未执行的工具协议文本，本轮未完成，请重试。",
                tool_usage=metrics(),
                evidence_state=ledger.snapshot(),
            )
            return

        messages_state = (
            ModelMessagesTypeAdapter.dump_python(all_messages, mode="json") if all_messages else []
        )
        yield Completed(
            text=final_text or "".join(collected),
            messages_state=trim_messages_state(messages_state),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            tool_usage=metrics(),
            report=holder.report,
            evidence_state=ledger.snapshot(),
        )
