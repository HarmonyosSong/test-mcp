from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import shutil
import signal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import anyio

from .inspector import ProjectInspector

MAX_INDEX_OUTPUT_CHARS = 16_000
MAX_PROCESS_OUTPUT_BYTES = 512_000
MAX_INDEX_FILES = 50_000
MAX_INDEX_BYTES = 256_000_000
INDEX_EXCLUDED_DIRS = {
    ".venv",
    "venv",
    "Pods",
    "Carthage",
    ".gradle",
    ".build",
    "DerivedData",
    "vendor",
    ".next",
    "coverage",
    ".cxx",
}
CODE_EXTENSIONS = {
    ".ets",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".swift",
    ".m",
    ".mm",
    ".h",
    ".hpp",
    ".c",
    ".cc",
    ".cpp",
    ".java",
    ".kt",
    ".kts",
}
NAVIGATION_BOUNDARY = (
    "Static navigation only, not observed evidence. Read the same snapshot with "
    "read_project_file before citing source. Empty results do not exclude dynamic calls."
)


class CodeIndexUnavailable(RuntimeError):
    """Optional backend failure; never interpret it as no code matches."""


class CodeIndexBackend:
    """Private CBM CLI adapter; no upstream management tools reach the model.

    Index a copy of allowed code, not the authorized repository itself. The copy
    excludes symlinks, dependencies, binaries and generated directories. Its
    identity includes source bytes, original root, engine build and adapter mode.
    """

    def __init__(self, inspector: ProjectInspector) -> None:
        self.inspector = inspector
        self.workspace = inspector.root
        command_text = os.environ.get("HARMONY_AGENT_CODE_INDEX_COMMAND", "").strip()
        self._configured = bool(command_text)
        # Treat an existing absolute path with spaces as one executable.
        try:
            self.command = (
                (
                    (command_text,)
                    if Path(command_text).is_file()
                    else tuple(shlex.split(command_text))
                )
                if command_text
                else ()
            )
        except (ValueError, OSError):
            self.command = ()
        self.mode = os.environ.get("HARMONY_AGENT_CODE_INDEX_MODE", "fast").strip() or "fast"
        cache = os.environ.get("HARMONY_AGENT_CODE_INDEX_CACHE", "").strip()
        self.cache_dir = Path(cache or ".data/codebase-memory").expanduser().resolve()
        try:
            self.timeout_seconds = max(
                5, min(int(os.environ.get("HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS", "90")), 600)
            )
        except ValueError:
            self.timeout_seconds = 90
        self._lock = asyncio.Lock()
        self._fingerprint: str | None = None
        self._engine_identity: str | None = None
        self.project_name = ""
        self._source_dir: Path | None = None
        self._coverage: dict[str, Any] = {}

    @property
    def configured(self) -> bool:
        return self._configured

    async def search_symbols(
        self,
        query: str,
        *,
        file_pattern: str = "**/*",
        limit: int = 20,
    ) -> dict[str, Any]:
        if not query.strip() or len(query) > 300:
            raise ValueError("query must contain 1–300 characters")
        if (
            not file_pattern.strip()
            or len(file_pattern) > 300
            or Path(file_pattern).is_absolute()
            or ".." in Path(file_pattern).parts
        ):
            raise ValueError("file_pattern must be a bounded relative glob")
        return await self._query(
            "search_graph",
            {
                "query": query.strip(),
                "file_pattern": file_pattern,
                "limit": max(1, min(limit, 50)),
                "format": "json",
                "max_output_tokens": 3000,
            },
        )

    async def file_outline(self, relative_path: str, *, limit: int = 100) -> dict[str, Any]:
        if Path(relative_path).is_absolute() or ".." in Path(relative_path).parts:
            raise ValueError("relative_path must stay inside the authorized snapshot")
        path = self.inspector.validate_project_text_file(relative_path)
        if Path(path).suffix.lower() not in CODE_EXTENSIONS:
            raise ValueError("file type is not supported by code navigation")
        return await self._query(
            "get_file_outline",
            {
                "file_path": path,
                "limit": max(1, min(limit, 100)),
                "format": "json",
            },
        )

    async def trace(
        self,
        function_name: str,
        *,
        direction: str = "inbound",
        depth: int = 1,
        limit: int = 20,
    ) -> dict[str, Any]:
        if not function_name.strip() or len(function_name) > 300:
            raise ValueError("function_name must contain 1–300 characters")
        if direction not in {"inbound", "outbound", "both"} or not 1 <= depth <= 5:
            raise ValueError("direction must be inbound/outbound/both and depth between 1 and 5")
        return await self._query(
            "trace_path",
            {
                "function_name": function_name.strip(),
                "direction": direction,
                "depth": depth,
                "limit": max(1, min(limit, 50)),
                "format": "json",
                "include_evidence": True,
                "max_output_tokens": 3000,
            },
        )

    async def _query(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if not self.command or not shutil.which(self.command[0]):
            raise CodeIndexUnavailable(
                "code_index_unavailable: command is not executable; use search_project_text"
            )
        if self.mode != "fast":
            raise CodeIndexUnavailable("code_index_unsupported: only fast mode is accepted")
        if self.cache_dir == self.workspace:
            raise CodeIndexUnavailable(
                "code_index_configuration_error: cache must not be workspace"
            )
        async with self._lock:
            # First navigation builds; later calls reject source changes rather than
            # silently mixing graph nodes from one tree with another tree's source.
            fingerprint, contents = await self._snapshot()
            if self._fingerprint and fingerprint != self._fingerprint:
                raise CodeIndexUnavailable(
                    "code_index_stale: workspace changed; "
                    "start a new round or use live search_project_text"
                )
            if not self._fingerprint:
                engine = await self._engine_version()
                digest = hashlib.sha256(
                    f"v2\0{self.workspace}\0{fingerprint}\0{engine}\0fast".encode()
                ).hexdigest()[:32]
                self.project_name = f"harmony-{digest}"
                self._source_dir = self._materialize(contents)
                indexed = await self._run_cli(
                    "index_repository",
                    {
                        "repo_path": str(self._source_dir),
                        "name": self.project_name,
                        "mode": "fast",
                        "persistence": False,
                    },
                )
                if indexed.get("status") != "indexed":
                    raise CodeIndexUnavailable("code_index_failed: index did not complete")
                self._coverage = {
                    key: indexed[key]
                    for key in (
                        "not_indexed_files_count",
                        "not_indexed_dirs_count",
                        "skipped_count",
                        "parse_partial_count",
                        "parse_unusable_count",
                        "nodes",
                        "edges",
                    )
                    if key in indexed
                }
                self._coverage["source_files"] = len(contents)
                self._fingerprint = fingerprint
            result = await self._run_cli(tool, {"project": self.project_name, **arguments})
            after, _ = await self._snapshot()
            if after != self._fingerprint or not self._view_matches(self._source_dir, contents):
                raise CodeIndexUnavailable(
                    "code_index_stale: workspace changed during query; use search_project_text"
                )
            return self._bound_result(result)

    async def _snapshot(self) -> tuple[str, dict[str, bytes]]:
        digest = hashlib.sha256()
        contents: dict[str, bytes] = {}
        total = 0
        # os.walk prunes excluded trees before traversing them. No symlinks are
        # copied, including links to otherwise permitted files in this snapshot.
        for directory, dirs, files in os.walk(self.workspace, followlinks=False):
            dirs[:] = sorted(
                name
                for name in dirs
                if name not in self.inspector.EXCLUDED_DIRS
                and name not in INDEX_EXCLUDED_DIRS
                and not (Path(directory) / name).is_symlink()
                and (Path(directory) / name) != self.cache_dir
            )
            for name in sorted(files):
                path = Path(directory) / name
                if path.suffix.lower() not in CODE_EXTENSIONS or path.is_symlink():
                    continue
                if not self.inspector._is_text_candidate(path):
                    continue
                relative = self.inspector.validate_project_text_file(
                    str(path.relative_to(self.workspace))
                )
                data = path.read_bytes()
                total += len(data)
                if len(contents) >= MAX_INDEX_FILES or total > MAX_INDEX_BYTES:
                    raise CodeIndexUnavailable(
                        "code_index_scope_limit: narrow the workspace or use search_project_text"
                    )
                contents[relative] = data
                digest.update(relative.encode() + b"\0" + hashlib.sha256(data).digest())
                if len(contents) % 100 == 0:
                    await anyio.lowlevel.checkpoint()
        return digest.hexdigest(), contents

    async def _engine_version(self) -> str:
        if self._engine_identity is None:
            version = await self._process(["--version"], timeout=5)
            if version.strip() != "codebase-memory-mcp 0.12.1":
                raise CodeIndexUnavailable("code_index_unsupported: expected CBM 0.12.1")
            executable = Path(shutil.which(self.command[0]) or self.command[0]).resolve()
            stat = executable.stat()
            self._engine_identity = (
                f"{version.strip()}:{executable}:{stat.st_size}:{stat.st_mtime_ns}"
            )
        return self._engine_identity

    @staticmethod
    def _view_matches(directory: Path | None, contents: dict[str, bytes]) -> bool:
        if directory is None or not directory.is_dir() or directory.is_symlink():
            return False
        try:
            actual = {}
            for root, dirs, files in os.walk(directory, followlinks=False):
                if any((Path(root) / name).is_symlink() for name in dirs):
                    return False
                for name in files:
                    path = Path(root) / name
                    relative = str(path.relative_to(directory))
                    if path.is_symlink() or relative not in contents:
                        return False
                    actual[relative] = path.read_bytes()
            return actual == contents
        except OSError:
            return False

    def _materialize(self, contents: dict[str, bytes]) -> Path:
        self.cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        views = self.cache_dir / "source-views"
        views.mkdir(exist_ok=True, mode=0o700)
        destination = views / self.project_name
        # Always publish a complete view; another process can reuse it. Source
        # hashes make concurrent publishers equivalent. No hard links to originals.
        if destination.is_dir():
            if self._view_matches(destination, contents):
                return destination
            raise CodeIndexUnavailable(
                "code_index_cache_invalid: cached source view changed; "
                "clear the derived cache before retrying"
            )
        with TemporaryDirectory(prefix="staging-", dir=views) as temporary:
            stage = Path(temporary) / "source"
            stage.mkdir(mode=0o700)
            for relative, data in contents.items():
                path = stage / relative
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                path.write_bytes(data)
                path.chmod(0o600)
            try:
                stage.rename(destination)
            except OSError:
                if not self._view_matches(destination, contents):
                    raise
        return destination

    async def _run_cli(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        # A single JSON positional argument avoids flag injection and shell
        # interpretation, including names beginning with '-' and arbitrary '$()'.
        output = await self._process(
            [
                "cli",
                "--quiet",
                "--json",
                tool,
                json.dumps(arguments, ensure_ascii=False),
            ]
        )
        try:
            envelope = json.loads(output)
        except json.JSONDecodeError as error:
            raise CodeIndexUnavailable("code_index_protocol_error: invalid JSON") from error
        structured = envelope.get("structuredContent") if isinstance(envelope, dict) else None
        if isinstance(structured, dict) and structured.get("error") == "function not found":
            raise CodeIndexUnavailable(
                "code_index_symbol_not_found: find the qualified name with search_code_symbols; "
                "no indexed match does not exclude source code; use search_project_text"
            )
        if not isinstance(envelope, dict) or envelope.get("isError") is True:
            raise CodeIndexUnavailable(
                "code_index_failed: backend rejected the request; use search_project_text"
            )
        if isinstance(structured, dict):
            return structured
        for block in envelope.get("content", []):
            if isinstance(block, dict) and block.get("type") == "text":
                try:
                    value = json.loads(block.get("text", ""))
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    return value
        if "content" not in envelope:
            return envelope
        raise CodeIndexUnavailable("code_index_protocol_error: missing structured result")

    async def _process(self, arguments: list[str], *, timeout: int | None = None) -> str:
        environment = {
            key: value
            for key, value in os.environ.items()
            if key
            in {
                "PATH",
                "HOME",
                "USERPROFILE",
                "SYSTEMROOT",
                "WINDIR",
                "TMPDIR",
                "TMP",
                "TEMP",
            }
        }
        # CBM deliberately skips descendants of its engine cache during discovery.
        # Keep source copies beside that cache, never inside it.
        engine_cache = self.cache_dir / "engine"
        environment["CBM_CACHE_DIR"] = str(engine_cache)
        engine_cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command,
                *arguments,
                cwd=self._source_dir or self.cache_dir,
                env=environment,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=os.name != "nt",
            )
        except OSError as error:
            raise CodeIndexUnavailable("code_index_unavailable: cannot start backend") from error

        async def read_bounded(stream: asyncio.StreamReader | None) -> bytes:
            result = bytearray()
            assert stream is not None
            while chunk := await stream.read(16_384):
                result.extend(chunk)
                if len(result) > MAX_PROCESS_OUTPUT_BYTES:
                    raise CodeIndexUnavailable("code_index_output_limit: use a narrower query")
            return bytes(result)

        readers = [
            asyncio.create_task(read_bounded(stream)) for stream in (process.stdout, process.stderr)
        ]
        try:
            async with asyncio.timeout(timeout or self.timeout_seconds):
                stdout, _ = await asyncio.gather(*readers)
                await process.wait()
            if process.returncode != 0:
                # CLI errors can be valid MCP envelopes even with exit code 1.
                # Decode those in _run_cli; never expose raw stderr.
                if arguments[0] == "cli" and stdout.lstrip().startswith(b"{"):
                    return stdout.decode("utf-8")
                # Raw stderr can contain source text, local paths or credentials.
                raise CodeIndexUnavailable(
                    "code_index_failed: backend process failed; "
                    "check deployment or use search_project_text"
                )
            return stdout.decode("utf-8")
        except TimeoutError as error:
            raise CodeIndexUnavailable(
                "code_index_timeout: backend deadline exceeded; use search_project_text"
            ) from error
        finally:
            with anyio.CancelScope(shield=True):
                for reader in readers:
                    reader.cancel()
                await asyncio.gather(*readers, return_exceptions=True)
                if process.returncode is None:
                    try:
                        if os.name != "nt":
                            os.killpg(process.pid, signal.SIGTERM)
                        else:
                            process.terminate()
                        try:
                            await asyncio.wait_for(process.wait(), timeout=2)
                        except TimeoutError:
                            if os.name != "nt":
                                os.killpg(process.pid, signal.SIGKILL)
                            else:
                                process.kill()
                            await process.wait()
                    except ProcessLookupError:
                        pass

    def _bound_result(self, result: dict[str, Any]) -> dict[str, Any]:
        # Retain nested grouped rows (trace_path uses them). Disclose trimming;
        # omit navigation altogether when it exceeds the final response budget.
        truncated = False

        def bound(value: Any) -> Any:
            nonlocal truncated
            if isinstance(value, str) and len(value) > 1500:
                truncated = True
                return value[:1500] + "[truncated]"
            if isinstance(value, list):
                if len(value) > 100:
                    truncated = True
                return [bound(item) for item in value[:100]]
            if isinstance(value, dict):
                return {key: bound(item) for key, item in value.items()}
            return value

        navigation = bound(result)
        if len(json.dumps(navigation, ensure_ascii=False)) > MAX_INDEX_OUTPUT_CHARS - 1500:
            navigation = {
                "truncated": True,
                "reason": "output_budget",
                "hint": "Narrow the symbol or file; graph output omitted.",
            }
            truncated = True
        return {
            "navigation": navigation,
            "snapshot_id": self.project_name,
            "index_coverage": self._coverage,
            "adapter_truncated": truncated,
            "evidence_boundary": NAVIGATION_BOUNDARY,
            "scope": "Allowed code files only; known dependency/build directories, symlinks "
            "and oversized files excluded. Language and dynamic-call coverage are partial.",
        }
