from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..domain import SkillSummary


@dataclass(frozen=True, slots=True)
class LoadedSkill:
    name: str
    description: str
    version: str
    stage: str
    instructions: str
    source: Path
    modes: tuple[str, ...] = ("chat", "diagnosis")
    required_tools: tuple[str, ...] = ()

    def summary(self) -> SkillSummary:
        return SkillSummary(
            name=self.name,
            description=self.description,
            version=self.version,
            stage=self.stage,
        )
