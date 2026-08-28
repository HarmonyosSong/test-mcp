from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from harmony_agent import (
    DiagnosisWorkflow,
    HarmonyChatAgent,
    HarmonyDiagnosisAgent,
    HarmonyPromoteAgent,
)
from harmony_agent.config import Settings
from harmony_agent.repositories import (
    CaseRepository,
    ConversationRepository,
    RepositoryManager,
)
from harmony_agent.runtimes import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry


@dataclass(slots=True)
class ApplicationContainer:
    settings: Settings
    cases: CaseRepository
    conversations: ConversationRepository
    repositories: RepositoryManager
    model_gateway: ModelGateway
    skills: SkillRegistry
    diagnosis_agent: HarmonyDiagnosisAgent
    chat_agent: HarmonyChatAgent
    promote_agent: HarmonyPromoteAgent
    workflow: DiagnosisWorkflow


def build_container(settings: Settings) -> ApplicationContainer:
    cases = CaseRepository(settings.data_file)
    conversations = ConversationRepository(settings.conversations_data_file)
    repositories = RepositoryManager(settings)
    model_gateway = ModelGateway(settings)
    skills = SkillRegistry(_resolve_skills_dir(settings.skills_dir))
    skills.load()
    diagnosis_agent = HarmonyDiagnosisAgent(skills, model_gateway)
    chat_agent = HarmonyChatAgent(skills, model_gateway, repositories, conversations)
    promote_agent = HarmonyPromoteAgent(model_gateway)
    workflow = DiagnosisWorkflow(cases, settings, diagnosis_agent, model_gateway)
    return ApplicationContainer(
        settings=settings,
        cases=cases,
        conversations=conversations,
        repositories=repositories,
        model_gateway=model_gateway,
        skills=skills,
        diagnosis_agent=diagnosis_agent,
        chat_agent=chat_agent,
        promote_agent=promote_agent,
        workflow=workflow,
    )


def _resolve_skills_dir(path: Path) -> Path:
    if path.is_absolute():
        return path
    current = Path.cwd() / path
    if current.exists():
        return current
    return Path(__file__).resolve().parents[3] / path
