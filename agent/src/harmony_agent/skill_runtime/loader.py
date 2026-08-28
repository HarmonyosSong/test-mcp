from __future__ import annotations

from pathlib import Path

import yaml

from .models import LoadedSkill


class SkillLoader:
    def load_file(self, path: Path) -> LoadedSkill:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            raise ValueError(f"missing YAML frontmatter: {path}")
        try:
            _, frontmatter, body = text.split("---", 2)
        except ValueError as exc:
            raise ValueError(f"invalid frontmatter: {path}") from exc
        metadata = yaml.safe_load(frontmatter) or {}
        for key in ("name", "description"):
            if not metadata.get(key):
                raise ValueError(f"missing {key} in {path}")
        skill_metadata = metadata.get("metadata") or {}
        return LoadedSkill(
            name=str(metadata["name"]),
            description=str(metadata["description"]),
            version=str(skill_metadata.get("version", "0.1.0")),
            stage=str(skill_metadata.get("stage", "general")),
            instructions=body.strip(),
            source=path,
        )
