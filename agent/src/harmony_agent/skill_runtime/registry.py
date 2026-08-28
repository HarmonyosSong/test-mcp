from __future__ import annotations

from pathlib import Path

from ..domain import SkillSummary
from .composer import compose_instructions
from .loader import SkillLoader
from .models import LoadedSkill
from .router import SkillRouter


class SkillRegistry:
    STAGE_ORDER = {"intake": 0, "locate": 1, "investigate": 2, "diagnose": 3, "general": 4}

    def __init__(
        self,
        skills_dir: Path,
        *,
        loader: SkillLoader | None = None,
        router: SkillRouter | None = None,
    ) -> None:
        self.skills_dir = skills_dir
        self.loader = loader or SkillLoader()
        self.router = router or SkillRouter()
        self._skills: dict[str, LoadedSkill] = {}

    def load(self) -> list[LoadedSkill]:
        self._skills = {}
        if not self.skills_dir.exists():
            return []
        for path in sorted(self.skills_dir.glob("*/SKILL.md")):
            skill = self.loader.load_file(path)
            if skill.name in self._skills:
                raise ValueError(f"duplicate skill name: {skill.name}")
            self._skills[skill.name] = skill
        return self.all()

    def all(self) -> list[LoadedSkill]:
        return sorted(
            self._skills.values(),
            key=lambda skill: (self.STAGE_ORDER.get(skill.stage, 99), skill.name),
        )

    def get(self, name: str) -> LoadedSkill | None:
        return self._skills.get(name)

    def summaries(self) -> list[SkillSummary]:
        return [skill.summary() for skill in self.all()]

    def instructions(self, stages: set[str] | None = None) -> str:
        return compose_instructions(self.router.for_stages(self.all(), stages))
