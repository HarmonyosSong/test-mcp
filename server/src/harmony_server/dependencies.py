from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from harmony_agent import HarmonyChatAgent
from harmony_agent.config import Settings
from harmony_agent.repositories import ConversationRepository, RepositoryManager
from harmony_agent.runtimes import ModelGateway
from harmony_agent.skill_runtime import SkillRegistry


@dataclass(slots=True)
class ApplicationContainer:
    settings: Settings
    conversations: ConversationRepository
    repositories: RepositoryManager
    model_gateway: ModelGateway
    skills: SkillRegistry
    chat_agent: HarmonyChatAgent


def build_container(settings: Settings) -> ApplicationContainer:
    conversations = ConversationRepository(settings.conversations_data_file)
    repositories = RepositoryManager(settings)
    model_gateway = ModelGateway(settings)
    skills = SkillRegistry(_resolve_skills_dir(settings.skills_dir))
    skills.load()
    chat_agent = HarmonyChatAgent(skills, model_gateway, repositories, conversations)
    return ApplicationContainer(
        settings=settings,
        conversations=conversations,
        repositories=repositories,
        model_gateway=model_gateway,
        skills=skills,
        chat_agent=chat_agent,
    )


def _resolve_skills_dir(path: Path) -> Path:
    if path.is_absolute():
        return path
    current = Path.cwd() / path
    if current.exists():
        return current
    return Path(__file__).resolve().parents[3] / path
