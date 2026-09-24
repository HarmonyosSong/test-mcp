from dataclasses import dataclass
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.capabilities import AbstractCapability, WrapModelRequestHandler
from pydantic_ai.messages import ModelResponse
from pydantic_ai.models import ModelRequestContext


@dataclass
class CountModelRequests(AbstractCapability[Any]):
    """Count agent-level attempts, including requests that fail before returning usage."""

    requests: int = 0

    async def wrap_model_request(
        self,
        ctx: RunContext[Any],
        *,
        request_context: ModelRequestContext,
        handler: WrapModelRequestHandler,
    ) -> ModelResponse:
        self.requests += 1
        return await handler(request_context)
