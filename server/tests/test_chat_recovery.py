from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import anyio
import pytest
from harmony_agent.agents import TextDelta, ToolStarted
from harmony_agent.domain import ChatMessageStatus, Conversation, ToolEvent
from harmony_agent.repositories import ConversationRepository
from pydantic_ai import ModelMessagesTypeAdapter

from harmony_server.chat_stream import _stream_chat_turn
from harmony_server.services.conversations import begin_turn


@pytest.mark.parametrize("cancel_mode", ["task", "scope", "close", "disconnect"])
async def test_interrupted_stream_saves_terminal_state_and_preserves_input(tmp_path, cancel_mode):
    repository = ConversationRepository(tmp_path / "conversations.json")
    await repository.initialize()
    conversation = Conversation()
    assistant = begin_turn(conversation, "Error ORIGINAL_LOG at Checkout.ets:88")
    await repository.save(conversation)
    entered = asyncio.Event()
    closed = asyncio.Event()

    class BlockingAgent:
        async def stream_turn(self, *_args):
            try:
                yield TextDelta("PARTIAL_UNVERIFIED_CONCLUSION")
                yield ToolStarted(
                    ToolEvent(tool="read_project_file", status="running", summary="read")
                )
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed.set()

    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=cancel_mode == "disconnect"))
    container = SimpleNamespace(
        conversations=repository,
        chat_agent=BlockingAgent(),
        settings=SimpleNamespace(
            conversations_data_file=repository.data_file, knowledge_query_log="off"
        ),
    )
    stream = _stream_chat_turn(request, container, "run", conversation.id, assistant.id)

    async def consume():
        async for _ in stream:
            pass

    if cancel_mode == "close":
        await anext(stream)
        await stream.aclose()
    elif cancel_mode == "disconnect":
        await consume()
    elif cancel_mode == "task":
        task = asyncio.create_task(consume())
        await asyncio.wait_for(entered.wait(), 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        async with anyio.create_task_group() as group:
            group.start_soon(consume)
            await asyncio.wait_for(entered.wait(), 3)
            group.cancel_scope.cancel()

    saved = await repository.get(conversation.id)
    assert saved.messages[-1].status == ChatMessageStatus.FAILED
    assert saved.messages[-1].error
    archived = json.loads(next((tmp_path / "knowledge-cases").glob("*.json")).read_text())
    assert archived["message"]["status"] == "failed"
    assert archived["review"] is None
    assert all(step.status != "running" for step in saved.messages[-1].steps)
    if cancel_mode != "close":
        assert closed.is_set()
    serialized = json.dumps(saved.messages_state, ensure_ascii=False)
    assert "ORIGINAL_LOG" in serialized
    assert "PARTIAL_UNVERIFIED_CONCLUSION" not in serialized
    assert "tool-call" not in serialized
    ModelMessagesTypeAdapter.validate_python(saved.messages_state)

    reloaded = ConversationRepository(repository.data_file)
    await reloaded.initialize()
    assert (await reloaded.get(conversation.id)).messages_state == saved.messages_state
