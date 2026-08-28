from __future__ import annotations

from collections.abc import Iterable

from .models import LoadedSkill


class SkillRouter:
    def for_stages(
        self,
        skills: Iterable[LoadedSkill],
        stages: set[str] | None = None,
    ) -> list[LoadedSkill]:
        if not stages:
            return list(skills)
        return [skill for skill in skills if skill.stage in stages or skill.stage == "general"]
