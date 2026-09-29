from __future__ import annotations

import copy
import json
from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator
from pydantic_ai import ModelMessagesTypeAdapter
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

from .models import DiagnosisReport, ToolEvent, utc_now


class ChatMessageStatus(StrEnum):
    STREAMING = "streaming"
    COMPLETED = "completed"
    FAILED = "failed"


class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: f"msg-{uuid4().hex[:10]}")
    role: Literal["user", "assistant"]
    content: str = ""
    steps: list[ToolEvent] = Field(default_factory=list)
    status: ChatMessageStatus = ChatMessageStatus.COMPLETED
    error: str | None = None
    # 本轮提交并通过证据校验的结构化诊断报告（仅 assistant 消息可能携带）
    report: DiagnosisReport | None = None
    # 本轮 token 用量（仅 assistant 消息在成功完成后写入）
    input_tokens: int | None = None
    output_tokens: int | None = None
    tool_usage: dict[str, int | str | None] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class Conversation(BaseModel):
    id: str = Field(default_factory=lambda: f"conv-{uuid4().hex[:10]}")
    title: str = "新会话"
    workspace_path: str | None = None
    repository_id: str | None = None
    repository_name: str | None = None
    requested_ref: str | None = None
    resolved_commit: str | None = None
    # 会话级模型覆盖："provider:model" 或纯模型名（沿用当前供应商）；空 = 全局配置
    model_override: str | None = Field(default=None, max_length=250)
    messages: list[ChatMessage] = Field(default_factory=list)
    # PydanticAI 的 ModelMessagesTypeAdapter.dump_python(mode="json") 产物，
    # 是模型视角的对话历史；与展示用的 messages 分离，互不污染。
    # 该字段不通过 API 返回给前端。
    messages_state: list[dict] = Field(default_factory=list)
    # 证据账本快照（EvidenceLedger.snapshot() 产物）：跨轮保留真实工具观测，
    # 使后续轮次提交的报告可以引用此前观测到的证据。不通过 API 返回给前端。
    evidence_state: dict = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def retain_failed_turn_input(self, assistant_id: str) -> None:
        """Retain the failed turn's input without unfinished tool calls or partial conclusions."""
        index = next(
            (i for i, message in enumerate(self.messages) if message.id == assistant_id), None
        )
        if index is None or index == 0 or self.messages[index - 1].role != "user":
            return
        user = self.messages[index - 1]
        failed_turn = ModelMessagesTypeAdapter.dump_python(
            [
                ModelRequest(parts=[UserPromptPart(user.content, timestamp=user.created_at)]),
                ModelResponse(parts=[TextPart("上一轮回复未完成，未形成可复用的排查结论。")]),
            ],
            mode="json",
        )
        self.messages_state = trim_messages_state([*self.messages_state, *failed_turn])


class CreateConversationRequest(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    workspace_path: str | None = Field(default=None, max_length=2_000)
    repository_id: str | None = Field(default=None, max_length=100)
    branch: str | None = Field(default=None, max_length=500)

    @field_validator("title", mode="before")
    @classmethod
    def strip_title(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("workspace_path", "repository_id", "branch", mode="before")
    @classmethod
    def normalize_optional_text(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    def validate_source(self) -> None:
        if bool(self.repository_id) != bool(self.branch):
            raise ValueError("repository_id and branch must be provided together")
        if self.workspace_path and self.repository_id:
            raise ValueError("workspace_path and repository_id are mutually exclusive")


class SendMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)

    @field_validator("content", mode="before")
    @classmethod
    def strip_content(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class RenameConversationRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title", mode="before")
    @classmethod
    def strip_title(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class UpdateConversationRequest(BaseModel):
    """会话局部更新：标题与模型覆盖均可选；model_override 传空串表示清除覆盖。"""

    title: str | None = Field(default=None, min_length=1, max_length=120)
    model_override: str | None = Field(default=None, max_length=250)

    @field_validator("title", mode="before")
    @classmethod
    def strip_title(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("model_override", mode="before")
    @classmethod
    def normalize_model_override(cls, value: object) -> object:
        # 空串是合法的「清除覆盖」语义，不转成 None（None 表示未提供该字段）
        return value.strip() if isinstance(value, str) else value


class ConversationSummary(BaseModel):
    id: str
    title: str
    repository_name: str | None = None
    message_count: int
    updated_at: datetime

    @classmethod
    def from_conversation(cls, conversation: Conversation) -> ConversationSummary:
        return cls(
            id=conversation.id,
            title=conversation.title,
            repository_name=conversation.repository_name,
            message_count=len(conversation.messages),
            updated_at=conversation.updated_at,
        )


def _state_size(state: list[dict]) -> int:
    return len(json.dumps(state, ensure_ascii=False, default=str))


RECAP_PREFIX = "[Earlier user statements and assistant hypotheses; not verified evidence]\n"
# Trusted instructions and tool-side bounded knowledge payloads must stay usable as returned.
COMPLETE_TOOL_RETURNS = {
    "load_skill",
    "lookup_issue",
    "get_knowledge_entry",
    "resolve_external_knowledge",
    "read_external_knowledge",
}

# 有界页协议(方案 §5):读取层已按字符预算/结果上限裁剪的源码页(FileContent)与
# 搜索页(SearchPage)通过 schema + 大小复核后完整保留,runtime 不再二次截坏。
# 判定只看结构与大小,不给任意同名工具结果无条件免裁剪。
_FILE_PAGE_KEYS = {
    "path",
    "start_line",
    "end_line",
    "requested_end_line",
    "total_lines",
    "content",
    "truncated",
    "next_line",
    "has_more_in_file",
    "truncation_reason",
}
_SEARCH_PAGE_KEYS = {
    "query",
    "file_glob",
    "matches",
    "truncated",
    "scanned_files",
    "scan_limit_reached",
    "next_cursor",
}
# 协议硬上限 12000 字符正文 + 行号/字段/引用元数据开销;超过即视为不受控返回。
_BOUNDED_PAGE_MAX_CHARS = 16_000


def _is_bounded_page(content: object) -> bool:
    """识别通过 schema 与大小检查的源码页/搜索页(含证据账本包装)。

    包装形态 {"evidence_refs": [...], "result": <页>} 时引用元数据随页一起
    按总大小复核;结构缺字段或超过协议硬上限的返回不豁免裁剪。
    """
    if not isinstance(content, dict):
        return False
    payload = content
    if isinstance(content.get("result"), dict) and isinstance(content.get("evidence_refs"), list):
        payload = content["result"]
    if not (payload.keys() >= _FILE_PAGE_KEYS or payload.keys() >= _SEARCH_PAGE_KEYS):
        return False
    return len(json.dumps(content, ensure_ascii=False, default=str)) <= _BOUNDED_PAGE_MAX_CHARS


def _turn_excerpt(messages: list[dict]) -> str:
    excerpts: list[str] = []
    for message in messages:
        for part in message.get("parts", []):
            content = part.get("content", "")
            if part.get("part_kind") == "user-prompt" and isinstance(content, str):
                if content.startswith(RECAP_PREFIX):
                    excerpts.append(content[len(RECAP_PREFIX) :])
                else:
                    excerpts.append(f"User: {content[:1200]}")
            elif part.get("part_kind") == "text":
                excerpts.append(f"Assistant: {content[:1200]}")
    return "\n".join(excerpts)


def trim_messages_state(
    state: list[dict],
    *,
    max_messages: int = 40,
    max_chars: int = 60_000,
    tool_return_max_chars: int = 4_000,
) -> list[dict]:
    """按用户轮次裁剪，保留工具配对和最近问答摘录；当前轮完整性优先于软上限。"""
    if not state:
        return []

    trimmed = copy.deepcopy(state)
    for message in trimmed:
        for part in message.get("parts", []):
            if part.get("part_kind") != "tool-return":
                continue
            if part.get("tool_name") in COMPLETE_TOOL_RETURNS:
                continue
            content = part.get("content")
            if _is_bounded_page(content):
                # 有界页在读取层已按协议限制大小,完整保留,不二次截坏
                continue
            text = (
                content
                if isinstance(content, str)
                else json.dumps(content, ensure_ascii=False, default=str)
            )
            if len(text) > tool_return_max_chars:
                # 截断必须附原始长度:模型要知道丢了多少,才能判断是否需要按行号
                # 精准补读,而不是把残文当全部(实测因此反复通读文件头)。
                if isinstance(content, str):
                    part["content"] = (
                        text[:tool_return_max_chars]
                        + f"\n...(已截断,原文共 {len(text)} 字符,仅存前 {tool_return_max_chars})"
                    )
                else:
                    # 旧版/不受控的结构化返回:不再把 JSON 字符串拦腰切成无效结构,
                    # 改为有效的结构化说明 + 可读摘录。
                    part["content"] = {
                        "runtime_truncated": True,
                        "original_chars": len(text),
                        "content_preview": text[:tool_return_max_chars],
                        "note": f"已截断,原文共 {len(text)} 字符,仅存前 {tool_return_max_chars}",
                    }

    def over_budget() -> bool:
        return len(trimmed) > max_messages or _state_size(trimmed) > max_chars

    while over_budget():
        starts = [
            index
            for index, message in enumerate(trimmed)
            if any(part.get("part_kind") == "user-prompt" for part in message.get("parts", []))
        ]
        if len(starts) < 2:
            break
        drop = starts[1]
        recap = _turn_excerpt(trimmed[:drop])[-4000:]
        trimmed = trimmed[drop:]
        trimmed[0]["parts"].insert(
            0,
            {
                "part_kind": "user-prompt",
                "content": RECAP_PREFIX + recap,
            },
        )
    return trimmed
