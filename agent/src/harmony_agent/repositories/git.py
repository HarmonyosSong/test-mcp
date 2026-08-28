from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from urllib.parse import unquote, urlsplit

from ..config import Settings
from ..domain import (
    RegisterRepositoryRequest,
    RepositoryBranch,
    RepositoryRecord,
    RepositorySnapshot,
)


class RepositoryNotFoundError(KeyError):
    pass


class RepositoryAlreadyExistsError(ValueError):
    pass


class RepositoryGitError(RuntimeError):
    pass


class RepositoryManager:
    def __init__(self, settings: Settings) -> None:
        self.data_file = settings.repository_data_file
        self.mirror_dir = settings.git_mirror_dir
        self.snapshot_dir = settings.snapshot_dir
        self.timeout_seconds = settings.git_timeout_seconds
        self.allowed_roots = settings.allowed_roots
        self._records: dict[str, RepositoryRecord] = {}
        self._lock = asyncio.Lock()
        self._repo_locks: dict[str, asyncio.Lock] = {}

    async def initialize(self) -> None:
        async with self._lock:
            if not self.data_file.exists():
                return
            raw = await asyncio.to_thread(self.data_file.read_text, encoding="utf-8")
            if not raw.strip():
                return
            values = json.loads(raw)
            self._records = {item["id"]: RepositoryRecord.model_validate(item) for item in values}

    async def list(self) -> list[RepositoryRecord]:
        async with self._lock:
            records = sorted(self._records.values(), key=lambda item: item.name.casefold())
            return [record.model_copy(deep=True) for record in records]

    async def get(self, repository_id: str) -> RepositoryRecord:
        async with self._lock:
            try:
                return self._records[repository_id].model_copy(deep=True)
            except KeyError as exc:
                raise RepositoryNotFoundError(repository_id) from exc

    async def register(self, request: RegisterRepositoryRequest) -> RepositoryRecord:
        self._validate_local_repository_url(request.url)
        remote_default = await self._remote_default_branch(request.url)
        default_branch = request.default_branch or remote_default
        branches = await self._remote_branches(request.url, pattern=default_branch)
        if not any(branch.name == default_branch for branch in branches):
            raise RepositoryGitError(f"remote branch not found: {default_branch}")
        async with self._lock:
            for existing in self._records.values():
                same_name = existing.name.casefold() == request.name.casefold()
                if same_name or existing.url == request.url:
                    raise RepositoryAlreadyExistsError("repository name or URL already registered")
            record = RepositoryRecord(
                name=request.name,
                url=request.url,
                default_branch=default_branch,
            )
            self._records[record.id] = record
            await self._persist_locked()
            return record.model_copy(deep=True)

    async def list_branches(
        self,
        repository_id: str,
        *,
        query: str = "",
        limit: int = 200,
    ) -> list[RepositoryBranch]:
        record = await self.get(repository_id)
        branches = await self._remote_branches(record.url)
        if query.strip():
            needle = query.strip().casefold()
            branches = [branch for branch in branches if needle in branch.name.casefold()]
        return branches[: max(1, min(limit, 500))]

    async def prepare_snapshot(
        self,
        repository_id: str,
        branch: str,
    ) -> RepositorySnapshot:
        record = await self.get(repository_id)
        repo_lock = self._repo_locks.setdefault(repository_id, asyncio.Lock())
        async with repo_lock:
            await self._validate_branch(branch)
            mirror = await self._ensure_mirror(record)
            remote_ref = f"refs/remotes/origin/{branch}"
            await self._git(
                "--git-dir",
                str(mirror),
                "fetch",
                "--no-tags",
                "--depth=1",
                "origin",
                f"+refs/heads/{branch}:{remote_ref}",
            )
            commit = (
                await self._git(
                    "--git-dir",
                    str(mirror),
                    "rev-parse",
                    f"{remote_ref}^{{commit}}",
                )
            ).strip()
            if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
                raise RepositoryGitError("git returned an invalid commit identifier")
            workspace = (self.snapshot_dir / repository_id / commit).resolve()
            metadata_path = workspace / ".harmony-agent-snapshot.json"
            if metadata_path.exists():
                return RepositorySnapshot.model_validate_json(
                    await asyncio.to_thread(metadata_path.read_text, encoding="utf-8")
                )
            if workspace.exists():
                raise RepositoryGitError("snapshot path exists without valid metadata")
            workspace.parent.mkdir(parents=True, exist_ok=True)
            try:
                await self._git(
                    "--git-dir",
                    str(mirror),
                    "worktree",
                    "add",
                    "--detach",
                    str(workspace),
                    commit,
                )
            except Exception:
                if workspace.exists() and self.snapshot_dir.resolve() in workspace.parents:
                    await asyncio.to_thread(shutil.rmtree, workspace)
                await self._git(
                    "--git-dir",
                    str(mirror),
                    "worktree",
                    "prune",
                    check=False,
                )
                raise
            snapshot = RepositorySnapshot(
                repository_id=record.id,
                repository_name=record.name,
                requested_ref=branch,
                resolved_commit=commit,
                workspace_path=str(workspace),
            )
            await asyncio.to_thread(
                metadata_path.write_text,
                snapshot.model_dump_json(indent=2),
                encoding="utf-8",
            )
            return snapshot

    async def _ensure_mirror(self, record: RepositoryRecord) -> Path:
        mirror = (self.mirror_dir / f"{record.id}.git").resolve()
        if mirror.exists():
            return mirror
        mirror.parent.mkdir(parents=True, exist_ok=True)
        await self._git("init", "--bare", str(mirror))
        await self._git(
            "--git-dir",
            str(mirror),
            "remote",
            "add",
            "origin",
            record.url,
        )
        return mirror

    async def _remote_default_branch(self, url: str) -> str:
        output = await self._git("ls-remote", "--symref", url, "HEAD")
        for line in output.splitlines():
            if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
                return line.removeprefix("ref: refs/heads/").removesuffix("\tHEAD")
        raise RepositoryGitError("remote did not advertise a default branch")

    async def _remote_branches(
        self,
        url: str,
        *,
        pattern: str | None = None,
    ) -> list[RepositoryBranch]:
        args = ["ls-remote", "--heads", url]
        if pattern:
            args.append(f"refs/heads/{pattern}")
        output = await self._git(*args)
        branches: list[RepositoryBranch] = []
        for line in output.splitlines():
            commit, separator, ref = line.partition("\t")
            if not separator or not ref.startswith("refs/heads/"):
                continue
            branches.append(RepositoryBranch(name=ref.removeprefix("refs/heads/"), commit=commit))
        return sorted(branches, key=lambda item: item.name.casefold())

    async def _validate_branch(self, branch: str) -> None:
        if branch.startswith("-") or any(ord(char) < 32 for char in branch):
            raise RepositoryGitError("invalid branch name")
        await self._git("check-ref-format", f"refs/heads/{branch}")

    def _validate_local_repository_url(self, url: str) -> None:
        parsed = urlsplit(url)
        if parsed.scheme != "file":
            return
        try:
            repository_path = Path(unquote(parsed.path)).resolve(strict=True)
        except (FileNotFoundError, OSError) as exc:
            raise RepositoryGitError("local repository path does not exist") from exc
        if not any(
            repository_path == root or root in repository_path.parents
            for root in self.allowed_roots
        ):
            raise RepositoryGitError("local repository is outside allowed roots")

    async def _persist_locked(self) -> None:
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            [record.model_dump(mode="json") for record in self._records.values()],
            ensure_ascii=False,
            indent=2,
        )
        temporary = self.data_file.with_suffix(f"{self.data_file.suffix}.tmp")
        await asyncio.to_thread(temporary.write_text, payload, encoding="utf-8")
        await asyncio.to_thread(temporary.replace, self.data_file)

    async def _git(self, *args: str, check: bool = True) -> str:
        environment = os.environ.copy()
        environment["GIT_TERMINAL_PROMPT"] = "0"
        process = await asyncio.create_subprocess_exec(
            "git",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise RepositoryGitError("git operation timed out") from exc
        if check and process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace").strip()
            raise RepositoryGitError(message or "git operation failed")
        return stdout.decode("utf-8", errors="replace")
