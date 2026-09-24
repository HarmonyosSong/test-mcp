from pydantic_ai import ModelMessagesTypeAdapter
from pydantic_ai.messages import ModelMessage

from ..domain import trim_messages_state


def prepare_history(messages: list[ModelMessage]) -> list[ModelMessage]:
    """Apply the same protocol-safe compaction before every model request and at persistence."""
    state = ModelMessagesTypeAdapter.dump_python(messages, mode="json")
    return ModelMessagesTypeAdapter.validate_python(trim_messages_state(state))
