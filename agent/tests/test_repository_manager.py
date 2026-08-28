from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from harmony_agent.config import Settings
from harmony_agent.domain import RegisterRepositoryRequest
from harmony_agent.repositories import RepositoryGitError, RepositoryManager


def git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def create_remote_repository(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git("init", "--bare", cwd=remote)
    source = tmp_path / "source"
    source.mkdir()
    git("init", "-b", "main", cwd=source)
    git("config", "user.name", "Test User", cwd=source)
    git("config", "user.email", "test@example.com", cwd=source)
    (source / "Order.ets").write_text("const state = 'created';\n", encoding="utf-8")
    git("add", "Order.ets", cwd=source)
    git("commit", "-m", "initial", cwd=source)
    git("remote", "add", "origin", remote.as_uri(), cwd=source)
    git("push", "-u", "origin", "main", cwd=source)
    git("symbolic-ref", "HEAD", "refs/heads/main", cwd=remote)
    git("switch", "-c", "feature/student-order", cwd=source)
    (source / "Order.ets").write_text("const state = 'paid';\n", encoding="utf-8")
    git("add", "Order.ets", cwd=source)
    git("commit", "-m", "paid state", cwd=source)
    git("push", "-u", "origin", "feature/student-order", cwd=source)
    return remote


def make_settings(tmp_path: Path) -> Settings:
    project_root = Path(__file__).resolve().parents[2]
    return Settings(
        mode="demo",
        data_file=tmp_path / "cases.json",
        repository_data_file=tmp_path / "repositories.json",
        git_mirror_dir=tmp_path / "mirrors",
        snapshot_dir=tmp_path / "snapshots",
        skills_dir=project_root / "skills",
        allowed_roots=[tmp_path],
        stage_delay_ms=0,
    )


def make_manager(tmp_path: Path) -> RepositoryManager:
    return RepositoryManager(make_settings(tmp_path))


async def test_register_branch_resolution_and_immutable_snapshot(tmp_path: Path) -> None:
    remote = create_remote_repository(tmp_path)
    manager = make_manager(tmp_path)
    await manager.initialize()

    record = await manager.register(
        RegisterRepositoryRequest(
            name="xesapp",
            url=remote.as_uri(),
        )
    )
    branches = await manager.list_branches(record.id)
    snapshot = await manager.prepare_snapshot(record.id, "feature/student-order")
    reused = await manager.prepare_snapshot(record.id, "feature/student-order")

    assert record.default_branch == "main"
    assert {branch.name for branch in branches} == {"main", "feature/student-order"}
    assert len(snapshot.resolved_commit) == 40
    assert Path(snapshot.workspace_path, "Order.ets").read_text(encoding="utf-8") == (
        "const state = 'paid';\n"
    )
    assert reused.workspace_path == snapshot.workspace_path
    assert reused.resolved_commit == snapshot.resolved_commit


async def test_snapshot_rejects_invalid_branch_name(tmp_path: Path) -> None:
    remote = create_remote_repository(tmp_path)
    manager = make_manager(tmp_path)
    record = await manager.register(RegisterRepositoryRequest(name="xesapp", url=remote.as_uri()))

    with pytest.raises(RepositoryGitError, match="invalid|ref format"):
        await manager.prepare_snapshot(record.id, "-malicious")


async def test_repository_registry_is_persistent(tmp_path: Path) -> None:
    remote = create_remote_repository(tmp_path)
    manager = make_manager(tmp_path)
    record = await manager.register(RegisterRepositoryRequest(name="xesapp", url=remote.as_uri()))
    reloaded = make_manager(tmp_path)

    await reloaded.initialize()

    assert (await reloaded.get(record.id)).url == remote.as_uri()
