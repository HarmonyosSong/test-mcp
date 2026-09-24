from pathlib import Path

import pytest
from fastmcp import Client
from harmony_knowledge_mcp.server import KNOWLEDGE_TOOL_NAMES, create_knowledge_server
from harmony_repo_mcp.server import MCP_TOOL_NAMES, create_mcp_server
from pydantic_ai.exceptions import ModelRetry

from harmony_agent.skill_runtime import SkillRegistry
from harmony_agent.toolsets.chat_workspace import build_chat_workspace_toolset
from harmony_agent.toolsets.skill_loader import build_skill_toolset


def test_loads_versioned_standard_skills() -> None:
    skills_dir = Path(__file__).resolve().parents[2] / "skills"
    registry = SkillRegistry(skills_dir)

    skills = registry.load()

    assert [skill.stage for skill in skills] == ["locate", "investigate", "diagnose", "general"]
    assert all(skill.version for skill in skills)
    assert "DevEco CLI" in registry.instructions()


def test_skill_selection_respects_mode_tools_and_explicit_stages() -> None:
    registry = SkillRegistry(Path(__file__).resolve().parents[2] / "skills")
    registry.load()
    tools = KNOWLEDGE_TOOL_NAMES | set(MCP_TOOL_NAMES)
    full = registry.available("chat", tools | {"bind_repository", "submit_diagnosis_report"})
    assert {skill.name for skill in full} == {
        "locate-harmony-issue",
        "investigate-harmony-evidence",
        "report-harmony-diagnosis",
        "bind-harmony-workspace",
    }
    without_submit = {skill.name for skill in registry.available("chat", tools)}
    assert "report-harmony-diagnosis" not in without_submit
    assert "bind-harmony-workspace" not in without_submit
    assert "locate-harmony-issue" not in {
        skill.name for skill in registry.available("chat", tools - {"lookup_issue"})
    }
    assert all(
        skill.stage != "general"
        for skill in registry.router.for_stages(
            registry.all(), {"locate", "investigate", "diagnose"}
        )
    )


def test_loading_cannot_bypass_filtered_skill_catalog() -> None:
    registry = SkillRegistry(Path(__file__).resolve().parents[2] / "skills")
    registry.load()
    allowed = {s.name for s in registry.available("chat", KNOWLEDGE_TOOL_NAMES)}
    load = build_skill_toolset(registry, allowed).tools["load_skill"].function
    for name in ("bind-harmony-workspace", "report-harmony-diagnosis"):
        with pytest.raises(ModelRetry):
            load(name)
    assert load("locate-harmony-issue") == registry.get("locate-harmony-issue").instructions


async def test_declared_tool_capabilities_match_registered_tools(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    async with Client(create_knowledge_server(root / "knowledge", query_log_path="off")) as client:
        assert {tool.name for tool in await client.list_tools()} == KNOWLEDGE_TOOL_NAMES
    async with Client(create_mcp_server(tmp_path)) as client:
        assert {tool.name for tool in await client.list_tools()} == set(MCP_TOOL_NAMES)
    workspace_names = set(build_chat_workspace_toolset().tools)
    assert workspace_names == set(MCP_TOOL_NAMES) | {"bind_repository"}
    assert not workspace_names & KNOWLEDGE_TOOL_NAMES
