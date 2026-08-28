from __future__ import annotations

from harmony_agent.domain import (
    ChatMessage,
    ChatMessageStatus,
    Conversation,
    CreateConversationRequest,
)

from ..dependencies import ApplicationContainer
from .sources import resolve_source

DEFAULT_TITLE = "新会话"


async def create_conversation(
    payload: CreateConversationRequest,
    container: ApplicationContainer,
) -> Conversation:
    payload.validate_source()
    source = await resolve_source(
        repository_id=payload.repository_id,
        branch=payload.branch,
        workspace_path=payload.workspace_path,
        container=container,
    )
    conversation = Conversation(
        title=payload.title or DEFAULT_TITLE,
        workspace_path=str(source.workspace) if source.workspace else None,
        repository_id=payload.repository_id,
        repository_name=source.repository_name,
        requested_ref=payload.branch,
        resolved_commit=source.resolved_commit,
    )
    return await container.conversations.save(conversation)


def begin_turn(conversation: Conversation, content: str) -> ChatMessage:
    """把用户消息和 streaming 占位 assistant 消息写入会话（由调用方负责 save）。"""
    conversation.messages.append(ChatMessage(role="user", content=content))
    assistant = ChatMessage(role="assistant", status=ChatMessageStatus.STREAMING)
    conversation.messages.append(assistant)
    # 首轮消息自动生成会话标题
    if conversation.title == DEFAULT_TITLE:
        conversation.title = content[:30] + ("…" if len(content) > 30 else "")
    return assistant


def public_conversation(conversation: Conversation) -> dict:
    """API/SSE 视图：剔除模型态历史 messages_state。"""
    return conversation.model_dump(mode="json", exclude={"messages_state"})
