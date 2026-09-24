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
        modes = skill_metadata.get("modes", ["chat", "diagnosis"])
        required_tools = skill_metadata.get("required_tools", [])
        if (
            not isinstance(modes, list)
            or not modes
            or any(mode not in ("chat", "diagnosis") for mode in modes)
        ):
            raise ValueError(f"invalid skill modes: {path}")
        if not isinstance(required_tools, list) or any(
            not isinstance(name, str) or not name.strip() for name in required_tools
        ):
            raise ValueError(f"invalid required_tools: {path}")
        return LoadedSkill(
            name=str(metadata["name"]),
            description=str(metadata["description"]),
            version=str(skill_metadata.get("version", "0.1.0")),
            stage=str(skill_metadata.get("stage", "general")),
            instructions=body.strip(),
            source=path,
            modes=tuple(modes),
            required_tools=tuple(required_tools),
        )
