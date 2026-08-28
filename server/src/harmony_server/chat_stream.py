from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from time import perf_counter
from uuid import uuid4

from ag_ui.core import EventType
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from harmony_agent.agents import Completed, Failed, TextDelta, ToolFinished, ToolStarted
from harmony_agent.domain import (
    ChatMessageStatus,
    SendMessageRequest,
    ToolEvent,
)
from harmony_agent.repositories import ConversationNotFoundError

from .dependencies import ApplicationContainer
from .services.conversations import begin_turn, public_conversation
from .sse import sse_event

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def chat_model_available(container: ApplicationContainer) -> bool:
    return container.model_gateway.enabled or container.chat_agent.model_override is not None


@router.post("/{conversation_id}/messages")
async def send_chat_message(
    conversation_id: str,
    payload: SendMessageRequest,
    request: Request,
) -> StreamingResponse:
    container: ApplicationContainer = request.app.state.container
    if not chat_model_available(container):
        raise HTTPException(status_code=409, detail="聊天需要先在模型设置中配置模型")
    try:
        conversation = await container.conversations.get(conversation_id)
    except ConversationNotFoundError as exc:
        raise HTTPException(status_code=404, detail="conversation not found") from exc
    if any(message.status == ChatMessageStatus.STREAMING for message in conversation.messages):
        raise HTTPException(status_code=409, detail="上一条回复尚未完成，请稍后再发送")

    assistant = begin_turn(conversation, payload.content)
    await container.conversations.save(conversation)
    run_id = f"run-{uuid4().hex[:12]}"
    return StreamingResponse(
        _stream_chat_turn(request, container, run_id, conversation.id, assistant.id),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


async def _stream_chat_turn(
    request: Request,
    container: ApplicationContainer,
    run_id: str,
    conversation_id: str,
    message_id: str,
) -> AsyncIterator[str]:
    conversation = await container.conversations.get(conversation_id)
    user_content = conversation.messages[-2].content if len(conversation.messages) >= 2 else ""
    yield sse_event(
        EventType.RUN_STARTED,
        run_id,
        conversation_id=conversation_id,
        conversation=public_conversation(conversation),
    )

    buffer: list[str] = []
    steps: list[ToolEvent] = []
    text_started = False
    final_text: str | None = None
    messages_state: list[dict] | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    error_message: str | None = None
    last_keepalive = perf_counter()

    try:
        async for event in container.chat_agent.stream_turn(conversation, user_content):
            if await request.is_disconnected():
                raise _ClientDisconnected
            if isinstance(event, TextDelta):
                if not text_started:
                    yield sse_event(EventType.TEXT_MESSAGE_START, run_id, message_id=message_id)
                    text_started = True
                buffer.append(event.delta)
                yield sse_event(
                    EventType.TEXT_MESSAGE_CONTENT,
                    run_id,
                    message_id=message_id,
                    delta=event.delta,
                )
            elif isinstance(event, ToolStarted):
                steps.append(event.event)
                yield sse_event(
                    EventType.TOOL_CALL_START,
                    run_id,
                    message_id=message_id,
                    tool_event=event.event,
                )
            elif isinstance(event, ToolFinished):
                steps = [event.event if step.id == event.event.id else step for step in steps]
                yield sse_event(
                    EventType.TOOL_CALL_END,
                    run_id,
                    message_id=message_id,
                    tool_event=event.event,
                )
            elif isinstance(event, Completed):
                final_text = event.text
                messages_state = event.messages_state
                input_tokens = event.input_tokens
                output_tokens = event.output_tokens
            elif isinstance(event, Failed):
                error_message = event.error
            if perf_counter() - last_keepalive >= 10:
                yield ": keepalive\n\n"
                last_keepalive = perf_counter()
    except _ClientDisconnected:
        error_message = "回复中断：客户端已断开连接"
    except asyncio.CancelledError:
        error_message = "回复中断：服务正在关闭"
        raise
    except Exception as exc:  # noqa: BLE001 —— 失败必须如实落盘，不伪造完成
        error_message = f"{type(exc).__name__}: {exc}"

    # 终态落盘：成功时合并模型历史；失败/中断保留部分正文并标记 failed，
    # messages_state 不合并，避免半截 tool-call 对污染后续轮次。
    conversation = await container.conversations.get(conversation_id)
    assistant = next(
        (message for message in conversation.messages if message.id == message_id), None
    )
    if assistant is not None:
        assistant.steps = steps
        if final_text is not None and error_message is None:
            assistant.content = final_text
            assistant.status = ChatMessageStatus.COMPLETED
            assistant.input_tokens = input_tokens
            assistant.output_tokens = output_tokens
            conversation.messages_state = messages_state or []
        else:
            assistant.content = "".join(buffer)
            assistant.status = ChatMessageStatus.FAILED
            assistant.error = error_message or "回复中断"
        await container.conversations.save(conversation)

    public = public_conversation(conversation)
    if text_started:
        yield sse_event(EventType.TEXT_MESSAGE_END, run_id, message_id=message_id)
    yield sse_event(
        EventType.STATE_SNAPSHOT, run_id, conversation_id=conversation_id, conversation=public
    )
    if final_text is not None and error_message is None:
        yield sse_event(
            EventType.RUN_FINISHED, run_id, conversation_id=conversation_id, conversation=public
        )
    else:
        yield sse_event(
            EventType.RUN_ERROR,
            run_id,
            conversation_id=conversation_id,
            message_id=message_id,
            error=error_message or "回复中断",
            conversation=public,
        )


class _ClientDisconnected(Exception):
    pass
