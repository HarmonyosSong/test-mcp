import pytest

from harmony_agent.domain import ChatMessage, ChatMessageStatus, Conversation
from harmony_agent.repositories import ConversationNotFoundError, ConversationRepository


async def test_conversation_repository_crud_and_reload(tmp_path) -> None:
    data_file = tmp_path / ".data" / "conversations.json"
    repository = ConversationRepository(data_file)
    await repository.initialize()

    conversation = Conversation(title="登录页排查")
    conversation.messages.append(ChatMessage(role="user", content="登录页点击没反应"))
    await repository.save(conversation)

    listed = await repository.list()
    assert [item.id for item in listed] == [conversation.id]

    fetched = await repository.get(conversation.id)
    assert fetched.title == "登录页排查"
    assert fetched.messages[0].content == "登录页点击没反应"

    # 模拟进程重启：从磁盘重新加载
    reloaded = ConversationRepository(data_file)
    await reloaded.initialize()
    restored = await reloaded.get(conversation.id)
    assert restored.title == "登录页排查"
    assert restored.messages[0].role == "user"

    await reloaded.delete(conversation.id)
    assert await reloaded.list() == []
    with pytest.raises(ConversationNotFoundError):
        await reloaded.get(conversation.id)


async def test_conversation_repository_missing_raises(tmp_path) -> None:
    repository = ConversationRepository(tmp_path / "missing.json")
    await repository.initialize()
    with pytest.raises(ConversationNotFoundError):
        await repository.get("conv-nothing")
    with pytest.raises(ConversationNotFoundError):
        await repository.delete("conv-nothing")


async def test_restart_keeps_interrupted_user_input_without_duplicate_recovery(tmp_path) -> None:
    repository = ConversationRepository(tmp_path / "conversations.json")
    conversation = Conversation(
        messages=[
            ChatMessage(role="user", content="Error original log"),
            ChatMessage(role="assistant", status=ChatMessageStatus.STREAMING),
        ]
    )
    await repository.save(conversation)
    await repository.initialize()
    recovered = await repository.get(conversation.id)
    assert recovered.messages[-1].status == ChatMessageStatus.FAILED
    assert recovered.messages_state[0]["parts"][0]["content"] == "Error original log"
    await repository.initialize()
    assert (await repository.get(conversation.id)).messages_state == recovered.messages_state
