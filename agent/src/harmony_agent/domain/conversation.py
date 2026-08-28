from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

from .models import CreateCaseRequest, ToolEvent, utc_now


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
    case_id: str | None = None
    # 本轮 token 用量（仅 assistant 消息在成功完成后写入）
    input_tokens: int | None = None
    output_tokens: int | None = None
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
    case_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


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


class CaseDraft(CreateCaseRequest):
    """promote 提取出的诊断案例草稿，字段与 CreateCaseRequest 完全对齐。"""


class LinkCaseRequest(BaseModel):
    case_id: str = Field(min_length=1, max_length=100)


class ConversationSummary(BaseModel):
    id: str
    title: str
    repository_name: str | None = None
    message_count: int
    case_ids: list[str] = Field(default_factory=list)
    updated_at: datetime

    @classmethod
    def from_conversation(cls, conversation: Conversation) -> ConversationSummary:
        return cls(
            id=conversation.id,
            title=conversation.title,
            repository_name=conversation.repository_name,
            message_count=len(conversation.messages),
            case_ids=list(conversation.case_ids),
            updated_at=conversation.updated_at,
        )


def _state_size(state: list[dict]) -> int:
    total = 0
    for message in state:
        for part in message.get("parts", []):
            content = part.get("content")
            if isinstance(content, str):
                total += len(content)
            else:
                total += len(str(content)) if content is not None else 0
    return total


def trim_messages_state(
    state: list[dict],
    *,
    max_messages: int = 40,
    max_chars: int = 60_000,
    tool_return_max_chars: int = 4_000,
) -> list[dict]:
    """裁剪序列化后的模型对话历史，控制上下文体积。

    规则：
    1. 按「请求 -> 若干响应」的消息对从最旧开始整对丢弃，绝不拆开
       tool-call 与 tool-return 的配对（否则会产生模型协议错误）。
    2. 条数/字符仍超限时，截断 tool-return 部分的正文。
    """
    if not state:
        return []

    trimmed = list(state)

    def over_budget() -> bool:
        return len(trimmed) > max_messages or _state_size(trimmed) > max_chars

    # 整对丢弃：一个 pair 从一条 request 开始，到下一条 request 之前结束。
    # 至少保留最后一对（当前轮），避免把正在进行的对话掏空。
    while over_budget() and trimmed:
        if trimmed[0].get("kind") != "request":
            trimmed.pop(0)
            continue
        drop = 1
        while drop < len(trimmed) and trimmed[drop].get("kind") != "request":
            drop += 1
        if drop >= len(trimmed):
            break
        trimmed = trimmed[drop:]

    if over_budget():
        for message in trimmed:
            for part in message.get("parts", []):
                if part.get("part_kind") != "tool-return":
                    continue
                content = part.get("content")
                if isinstance(content, str) and len(content) > tool_return_max_chars:
                    part["content"] = content[:tool_return_max_chars] + "\n...(已截断)"
        # 截断后仍超条数上限的情况只能继续整对丢弃，由调用方保证上限合理。
    return trimmed
