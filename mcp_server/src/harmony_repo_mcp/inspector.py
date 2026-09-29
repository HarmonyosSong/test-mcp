from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Iterator
from pathlib import Path

from .schemas import (
    DEFAULT_READ_CHARS,
    DEFAULT_SEARCH_LIMIT,
    MAX_READ_CHARS,
    MAX_READ_LINES,
    MAX_SEARCH_LIMIT,
    BusinessContextDocument,
    FileContent,
    HilogSummary,
    LogLine,
    ReferencedFile,
    SearchMatch,
    SearchPage,
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
        limit: int = DEFAULT_SEARCH_LIMIT,
        cursor: str | None = None,
    ) -> SearchPage:
        """有界搜索页:遍历顺序确定,达到结果/文件数上限如实披露。

        cursor 续查只在同一 query/file_glob/工作区快照下合法;游标只在被截断的
        候选集内翻页,scan_limit_reached 时需缩小 file_glob 而不是续查。
        """
        if not query.strip():
            raise ValueError("query cannot be empty")
        safe_limit = max(1, min(limit, MAX_SEARCH_LIMIT))
        skip = self._decode_cursor(cursor, query=query, file_glob=file_glob) if cursor else 0
        needle = query.casefold()
        # 候选集先定界再排序:顺序确定,续查页才不会漏行或重复
        candidates: list[Path] = []
        scan_limit_reached = False
        for path in self._iter_project_files(file_glob):
            if len(candidates) >= self.max_search_files:
                scan_limit_reached = True
                break
            candidates.append(path)
        candidates.sort(key=lambda item: str(item.relative_to(self.root)))
        matches: list[SearchMatch] = []
        seen = 0
        scanned_files = 0
        truncated = False
        for path in candidates:
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            scanned_files += 1
            for number, line in enumerate(lines, start=1):
                if needle not in line.casefold():
                    continue
                if seen < skip:
                    seen += 1
                    continue
                matches.append(
                    SearchMatch(
                        path=str(path.relative_to(self.root)),
                        line=number,
                        excerpt=line.strip()[:500],
                    )
                )
                if len(matches) >= safe_limit:
                    truncated = True
                    break
            if truncated:
                break
        next_cursor = (
            self._encode_cursor(query=query, file_glob=file_glob, skip=skip + len(matches))
            if truncated
            else None
        )
        return SearchPage(
            query=query,
            file_glob=file_glob,
            matches=matches,
            truncated=truncated,
            scanned_files=scanned_files,
            scan_limit_reached=scan_limit_reached,
            next_cursor=next_cursor,
        )

    def read_project_file(
        self,
        relative_path: str,
        start_line: int = 1,
        end_line: int = 200,
        max_chars: int = DEFAULT_READ_CHARS,
    ) -> FileContent:
        """按行范围 + 字符预算读取单个文件,返回有界分页(字段语义见 FileContent)。

        行号与换行开销计入预算,整行交付、绝不把某行切一半再声称读完。
        非法范围(end_line < start_line)、预算连一行都容不下、起点超过 EOF 一律
        显式报错,不返回伪造的完整页,也不给出原地踏步的续读游标。
        """
        path = self._resolve_inside(self.root / relative_path)
        if not path.is_file() or not self._is_text_candidate(path):
            raise InspectionBoundaryError("file type is not allowed")
        if path.stat().st_size > self.max_file_bytes:
            raise InspectionBoundaryError("file exceeds read size limit")
        start = max(1, start_line)
        if end_line < start:
            raise ValueError(f"非法行范围:end_line({end_line}) 小于 start_line({start})")
        budget = max(1, min(max_chars, MAX_READ_CHARS))
        window_end = start + MAX_READ_LINES - 1  # 400 行窗口上限,字符预算不能绕过
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        total = len(lines)
        relative = str(path.relative_to(self.root))
        if total == 0:
            # 空文件:明确的空页(total_lines=0),不假装交付了内容
            return FileContent(
                path=relative,
                start_line=start,
                end_line=start - 1,
                requested_end_line=end_line,
                total_lines=0,
                content="",
                truncated=False,
                next_line=None,
                has_more_in_file=False,
            )
        if start > total:
            raise InspectionBoundaryError(
                f"start_line({start}) 超出文件末尾(共 {total} 行);请按 total_lines 调整范围"
            )
        target_end = min(end_line, window_end, total)
        delivered_end = start - 1
        skipped: list[int] = []
        reason: str | None = None
        resume: int | None = None
        used = 0
        selected: list[str] = []
        number = start
        while number <= target_end:
            line = lines[number - 1]
            cost = len(f"{number}: {line}") + 1  # 行号与换行计入预算
            if cost > MAX_READ_CHARS:
                # 单行连硬上限都放不下:结构化披露并越过该行,游标前进、禁止原地循环
                reason = "line_too_long"
                skipped.append(number)
                resume = number + 1 if number + 1 <= min(end_line, total) else None
                break
            if used + cost > budget:
                if not selected:
                    raise ValueError(
                        f"字符预算 {budget} 连第 {number} 行(含行号需 {cost} 字符)都容不下;"
                        f"请提高 max_chars(上限 {MAX_READ_CHARS})"
                    )
                reason = "character_budget"
                resume = number
                break
            selected.append(f"{number}: {line}")
            used += cost
            delivered_end = number
            number += 1
        if reason is None and end_line > window_end and window_end < total:
            # 请求超出 400 行窗口:窗口内已全量交付,但请求范围仍未完成
            reason = "line_range_limit"
            resume = window_end + 1
        return FileContent(
            path=relative,
            start_line=start,
            end_line=delivered_end,
            requested_end_line=end_line,
            total_lines=total,
            content="\n".join(selected),
            truncated=reason is not None,
            next_line=resume,
            has_more_in_file=delivered_end < total,
            truncation_reason=reason,
            skipped_lines=skipped,
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

    def _scope_token(self) -> str:
        # 游标绑定工作区快照:快照路径含 repository_id/commit,换快照即失效;
        # 用哈希避免把本机绝对路径泄漏进对话。
        return hashlib.sha256(str(self.root).encode()).hexdigest()[:12]

    def _encode_cursor(self, *, query: str, file_glob: str, skip: int) -> str:
        payload = {
            "v": 1,
            "query": query,
            "file_glob": file_glob,
            "skip": skip,
            "scope": self._scope_token(),
        }
        return base64.urlsafe_b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode()

    def _decode_cursor(self, cursor: str, *, query: str, file_glob: str) -> int:
        try:
            payload = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        except ValueError as exc:
            raise ValueError("续查游标无法解析;请去掉 cursor 重新搜索") from exc
        skip = payload.get("skip") if isinstance(payload, dict) else None
        if (
            not isinstance(payload, dict)
            or payload.get("v") != 1
            or not isinstance(skip, int)
            or isinstance(skip, bool)
            or skip < 0
        ):
            raise ValueError("续查游标格式无效;请去掉 cursor 重新搜索")
        if payload.get("scope") != self._scope_token():
            raise ValueError("续查游标绑定的是另一个工作区快照,不能跨快照复用;请重新搜索")
        if payload.get("query") != query or payload.get("file_glob") != file_glob:
            raise ValueError(
                "续查游标绑定了不同的 query/file_glob,不能跨条件复用;请保持原条件或重新搜索"
            )
        return skip

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
