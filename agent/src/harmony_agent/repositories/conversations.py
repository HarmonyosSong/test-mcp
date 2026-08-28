from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ..domain import ChatMessageStatus, Conversation, utc_now


class ConversationNotFoundError(KeyError):
    pass


class ConversationRepository:
    """会话的本地 JSON 持久化，模式与 CaseRepository 一致（内存索引 + 原子写）。"""

    def __init__(self, data_file: Path) -> None:
        self.data_file = data_file
        self._conversations: dict[str, Conversation] = {}
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        async with self._lock:
            if not self.data_file.exists():
                return
            raw = await asyncio.to_thread(self.data_file.read_text, encoding="utf-8")
            if not raw.strip():
                return
            values = json.loads(raw)
            self._conversations = {item["id"]: Conversation.model_validate(item) for item in values}
            # 进程重启意味着没有活着的流：把遗留的 streaming 消息如实标记为中断，
            # 否则前端会一直显示「正在思考」，且该会话因 409 保护无法再发消息。
            recovered = False
            for conversation in self._conversations.values():
                for message in conversation.messages:
                    if message.status == ChatMessageStatus.STREAMING:
                        message.status = ChatMessageStatus.FAILED
                        message.error = "回复中断：服务已重启"
                        recovered = True
            if recovered:
                await self._persist_locked()

    async def list(self) -> list[Conversation]:
        async with self._lock:
            conversations = sorted(
                self._conversations.values(), key=lambda item: item.updated_at, reverse=True
            )
            return [item.model_copy(deep=True) for item in conversations]

    async def get(self, conversation_id: str) -> Conversation:
        async with self._lock:
            try:
                return self._conversations[conversation_id].model_copy(deep=True)
            except KeyError as exc:
                raise ConversationNotFoundError(conversation_id) from exc

    async def save(self, conversation: Conversation) -> Conversation:
        async with self._lock:
            conversation.updated_at = utc_now()
            self._conversations[conversation.id] = conversation.model_copy(deep=True)
            await self._persist_locked()
            return conversation.model_copy(deep=True)

    async def delete(self, conversation_id: str) -> None:
        async with self._lock:
            try:
                del self._conversations[conversation_id]
            except KeyError as exc:
                raise ConversationNotFoundError(conversation_id) from exc
            await self._persist_locked()

    async def _persist_locked(self) -> None:
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            [item.model_dump(mode="json") for item in self._conversations.values()],
            ensure_ascii=False,
            indent=2,
        )
        temporary = self.data_file.with_suffix(f"{self.data_file.suffix}.tmp")
        await asyncio.to_thread(temporary.write_text, payload, encoding="utf-8")
        await asyncio.to_thread(temporary.replace, self.data_file)
