from __future__ import annotations

import json

from pydantic_ai import Agent, PromptedOutput
from pydantic_ai.models import Model

from ..domain import CaseDraft, Conversation, RepositoryRecord
from ..runtimes.model_gateway import ModelGateway
from .chat import ModelNotConfiguredError
from .prompts import PROMOTE_INSTRUCTIONS

# 单条消息进入提取 prompt 的长度上限，避免超长对话撑爆提取请求。
_MESSAGE_SNIPPET_LIMIT = 2_000


class HarmonyPromoteAgent:
    """从对话历史提取诊断案例草稿（只产草稿，不直接建案）。"""

    def __init__(self, model_gateway: ModelGateway) -> None:
        self.model_gateway = model_gateway
        self.model_override: Model | None = None

    async def extract(
        self,
        conversation: Conversation,
        repositories: list[RepositoryRecord],
    ) -> CaseDraft:
        model = self.model_override or await self.model_gateway.get_model()
        if model is None:
            raise ModelNotConfiguredError("提取案例草稿需要先在模型设置中配置模型")

        agent = Agent(
            model,
            output_type=PromptedOutput(CaseDraft),
            instructions=PROMOTE_INSTRUCTIONS,
            defer_model_check=True,
            retries=2,
        )
        payload = {
            "conversation": [
                {
                    "role": message.role,
                    "content": message.content[:_MESSAGE_SNIPPET_LIMIT],
                    "tools_used": [step.tool for step in message.steps],
                }
                for message in conversation.messages
                if message.status != "streaming"
            ],
            "bound_workspace": {
                "workspace_path": conversation.workspace_path,
                "repository_id": conversation.repository_id,
                "repository_name": conversation.repository_name,
                "branch": conversation.requested_ref,
            },
            "registered_repositories": [
                {
                    "id": repository.id,
                    "name": repository.name,
                    "default_branch": repository.default_branch,
                }
                for repository in repositories
            ],
        }
        result = await agent.run(json.dumps(payload, ensure_ascii=False))
        draft = result.output
        # 会话已有绑定时以绑定为准，防止模型擅自更换代码来源。
        if conversation.workspace_path:
            draft.workspace_path = conversation.workspace_path
            draft.repository_id = None
            draft.branch = None
        elif conversation.repository_id:
            draft.workspace_path = None
            draft.repository_id = conversation.repository_id
            draft.branch = conversation.requested_ref
        return draft
