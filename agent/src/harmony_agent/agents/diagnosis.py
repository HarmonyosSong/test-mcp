from __future__ import annotations

import json

from pydantic_ai import Agent, PromptedOutput

from ..domain import DiagnosisCase, DiagnosisReport, Evidence
from ..runtimes.model_gateway import ModelGateway
from ..skill_runtime.registry import SkillRegistry
from ..toolsets import build_repository_toolset
from .prompts import BASE_INSTRUCTIONS


class HarmonyDiagnosisAgent:
    def __init__(self, registry: SkillRegistry, model_gateway: ModelGateway) -> None:
        self.registry = registry
        self.model_gateway = model_gateway

    async def run(
        self,
        case: DiagnosisCase,
        evidence: list[Evidence],
        workspace_checks: list[str],
    ) -> DiagnosisReport:
        model = await self.model_gateway.get_model()
        if model is None:
            raise RuntimeError("model mode is not configured")
        toolset = build_repository_toolset(case)
        agent = Agent(
            model,
            output_type=PromptedOutput(DiagnosisReport),
            instructions=f"{BASE_INSTRUCTIONS}\n\n{self.registry.instructions()}",
            toolsets=[toolset] if toolset else [],
            defer_model_check=True,
            retries=2,
        )
        prompt = {
            "task": "Locate the issue, investigate evidence, and produce a diagnosis only.",
            "issue": {
                "title": case.title,
                "description": case.description,
                "pasted_evidence": case.input_evidence,
                "workspace_available": bool(case.workspace_path),
            },
            "precollected_evidence": [item.model_dump(mode="json") for item in evidence],
            "preliminary_checks": workspace_checks,
            "boundaries": {
                "read_only": True,
                "no_deveco_cli": True,
                "no_shell": True,
                "no_code_changes": True,
            },
        }
        result = await agent.run(json.dumps(prompt, ensure_ascii=False))
        return result.output
