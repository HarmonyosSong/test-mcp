from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

from .schemas import (
    BusinessContextDocument,
    FileContent,
    HilogSummary,
    LogLine,
    ReferencedFile,
    SearchMatch,
)


class InspectionBoundaryError(ValueError):
    pass


class ProjectInspector:
    TEXT_EXTENSIONS = {
        ".ets",
        ".ts",
        ".js",
        ".json5",
        ".json",
        ".xml",
        ".yaml",
        ".yml",
        ".md",
        ".txt",
        ".log",
        ".cpp",
        ".cc",
        ".c",
        ".h",
        ".hpp",
    }
    EXCLUDED_DIRS = {
        ".git",
        ".hvigor",
        ".idea",
        ".data",
        "build",
        "dist",
        "node_modules",
        "oh_modules",
    }
    BUSINESS_CONTEXT_PATTERNS = (
        "skills/*/SKILL.md",
        "harness_Engineering/knowledge/contracts/*.md",
        "harness_Engineering/knowledge/module_refs/*.md",
        "harness_Engineering/archive/v2/knowledge/module_refs/*.md",
        "docs/**/*.md",
        "xes_Harness.md",
        "README.md",
    )
    DOMAIN_TERMS = (
        "订单",
        "支付",
        "退款",
        "合同",
        "购物车",
        "课程",
        "学生",
        "登录",
        "账号",
        "webview",
        "媒体",
        "埋点",
        "权限",
    )

    def __init__(
        self,
        root: Path,
        *,
        max_file_bytes: int = 512_000,
        max_search_files: int = 5_000,
    ) -> None:
        resolved = root.expanduser().resolve(strict=True)
        if not resolved.is_dir():
            raise InspectionBoundaryError("workspace must be a directory")
        self.root = resolved
        self.max_file_bytes = max_file_bytes
        self.max_search_files = max_search_files

    def list_project_files(self, pattern: str = "**/*", limit: int = 100) -> list[str]:
        safe_limit = max(1, min(limit, 500))
        files: list[str] = []
        for path in self._iter_project_files(pattern):
            files.append(str(path.relative_to(self.root)))
            if len(files) >= safe_limit:
                break
        return sorted(files)

    def search_project_text(
        self,
        query: str,
        file_glob: str = "**/*",
        limit: int = 50,
    ) -> list[SearchMatch]:
        if not query.strip():
            raise ValueError("query cannot be empty")
        safe_limit = max(1, min(limit, 200))
        needle = query.casefold()
        matches: list[SearchMatch] = []
        for index, path in enumerate(self._iter_project_files(file_glob), start=1):
            if index > self.max_search_files:
                break
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for number, line in enumerate(lines, start=1):
                if needle in line.casefold():
                    matches.append(
                        SearchMatch(
                            path=str(path.relative_to(self.root)),
                            line=number,
                            excerpt=line.strip()[:500],
                        )
                    )
                    if len(matches) >= safe_limit:
                        return matches
        return matches

    def read_project_file(
        self,
        relative_path: str,
        start_line: int = 1,
        end_line: int = 200,
    ) -> FileContent:
        path = self._resolve_inside(self.root / relative_path)
        if not path.is_file() or not self._is_text_candidate(path):
            raise InspectionBoundaryError("file type is not allowed")
        if path.stat().st_size > self.max_file_bytes:
            raise InspectionBoundaryError("file exceeds read size limit")
        start = max(1, start_line)
        end = min(max(start, end_line), start + 399)
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        selected = lines[start - 1 : end]
        return FileContent(
            path=str(path.relative_to(self.root)),
            start_line=start,
            end_line=start + max(0, len(selected) - 1),
            content="\n".join(f"{number}: {line}" for number, line in enumerate(selected, start)),
            truncated=end < len(lines),
        )

    def load_business_context(
        self,
        query: str,
        limit: int = 8,
    ) -> list[BusinessContextDocument]:
        terms = self._context_terms(query)
        safe_limit = max(1, min(limit, 20))
        candidates: dict[str, BusinessContextDocument] = {}
        for pattern in self.BUSINESS_CONTEXT_PATTERNS:
            for path in self._iter_project_files(pattern):
                relative = str(path.relative_to(self.root))
                try:
                    content = path.read_text(encoding="utf-8", errors="replace")[:40_000]
                except OSError:
                    continue
                folded_path = relative.casefold()
                folded_content = content.casefold()
                score = sum(
                    8 * folded_path.count(term) + min(5, folded_content.count(term))
                    for term in terms
                )
                if score == 0:
                    continue
                candidates[relative] = BusinessContextDocument(
                    path=relative,
                    title=self._markdown_title(content, path.stem),
                    score=score,
                    excerpt=self._context_excerpt(content, terms),
                )
        return sorted(candidates.values(), key=lambda item: (-item.score, item.path))[:safe_limit]

    @staticmethod
    def parse_hilog(log_text: str, limit: int = 50) -> HilogSummary:
        lines = log_text.splitlines()
        error_pattern = re.compile(
            r"(?:\bE\b|ERROR|FATAL|Exception|\bTypeError\b|\bReferenceError\b|\bError:)"
        )
        path_pattern = re.compile(r"([\w./-]+\.(?:ets|ts|js|json5|cpp|cc|c|h))(?::(\d+))?")
        errors: list[LogLine] = []
        files: list[ReferencedFile] = []
        for number, line in enumerate(lines, start=1):
            if error_pattern.search(line) and len(errors) < limit:
                errors.append(LogLine(line=number, excerpt=line.strip()[:600]))
            for match in path_pattern.finditer(line):
                item = ReferencedFile(
                    path=match.group(1),
                    line=int(match.group(2) or 0) or None,
                )
                if item not in files:
                    files.append(item)
        return HilogSummary(
            line_count=len(lines),
            error_lines=errors,
            referenced_files=files[:limit],
        )

    def _iter_project_files(self, pattern: str) -> Iterator[Path]:
        for candidate in self.root.glob(pattern):
            if not candidate.is_file() or not self._is_text_candidate(candidate):
                continue
            try:
                yield self._resolve_inside(candidate)
            except InspectionBoundaryError:
                continue

    def _is_text_candidate(self, path: Path) -> bool:
        try:
            relative = path.relative_to(self.root)
        except ValueError:
            return False
        if any(part in self.EXCLUDED_DIRS for part in relative.parts):
            return False
        try:
            return (
                path.suffix.lower() in self.TEXT_EXTENSIONS
                and path.stat().st_size <= self.max_file_bytes
            )
        except OSError:
            return False

    def _resolve_inside(self, path: Path) -> Path:
        try:
            resolved = path.resolve(strict=True)
        except (FileNotFoundError, OSError) as exc:
            raise InspectionBoundaryError("path does not exist") from exc
        if resolved != self.root and self.root not in resolved.parents:
            raise InspectionBoundaryError("path escapes the authorized workspace")
        return resolved

    def _context_terms(self, query: str) -> list[str]:
        folded = query.casefold()
        terms = [term.casefold() for term in self.DOMAIN_TERMS if term.casefold() in folded]
        terms.extend(re.findall(r"[a-z][a-z0-9_-]{2,}", folded))
        return list(dict.fromkeys(terms)) or [folded.strip()]

    @staticmethod
    def _markdown_title(content: str, fallback: str) -> str:
        for line in content.splitlines():
            if line.startswith("# "):
                return line[2:].strip()[:120]
        return fallback

    @staticmethod
    def _context_excerpt(content: str, terms: list[str]) -> str:
        folded = content.casefold()
        positions = [folded.find(term) for term in terms if folded.find(term) >= 0]
        start = max(0, min(positions) - 300) if positions else 0
        return content[start : start + 1_500].strip()
