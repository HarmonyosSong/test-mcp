from __future__ import annotations

from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.toolsets import FunctionToolset

from ..skill_runtime.registry import SkillRegistry


def build_skill_toolset(registry: SkillRegistry) -> FunctionToolset[None]:
    """把 Skill 正文暴露为显式工具，使技能加载在聊天步骤流中可见。

    聊天 Agent 的 instructions 只携带技能目录（名称 + 描述），
    正文由模型按需通过 load_skill 加载。
    """

    toolset: FunctionToolset[None] = FunctionToolset()

    @toolset.tool_plain
    def load_skill(name: str) -> str:
        """按名称加载一个 HarmonyOS 诊断技能（SKILL.md 正文）。

        当任务匹配技能目录中某个技能的描述时，先调用本工具获取操作指引，
        再开始分析。一次最多加载与当前任务直接相关的 1-2 个技能。
        """
        skill = registry.get(name)
        if skill is None:
            available = ", ".join(item.name for item in registry.all()) or "（无）"
            raise ModelRetry(f"unknown skill '{name}', available skills: {available}")
        return skill.instructions

    return toolset
