from __future__ import annotations

from collections.abc import Iterable

from .models import LoadedSkill


def compose_instructions(skills: Iterable[LoadedSkill]) -> str:
    return "\n\n".join(
        f"## Skill: {skill.name} ({skill.stage})\n{skill.instructions.strip()}" for skill in skills
    )
