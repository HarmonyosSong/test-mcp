from pathlib import Path

from harmony_agent.skill_runtime import SkillRegistry


def test_loads_versioned_standard_skills() -> None:
    skills_dir = Path(__file__).resolve().parents[2] / "skills"
    registry = SkillRegistry(skills_dir)

    skills = registry.load()

    assert [skill.stage for skill in skills] == ["locate", "investigate", "diagnose", "general"]
    assert all(skill.version == "0.1.0" for skill in skills)
    assert "DevEco CLI" in registry.instructions()
