from __future__ import annotations

from pydantic import BaseModel, Field


class SearchMatch(BaseModel):
    path: str
    line: int
    excerpt: str


class FileContent(BaseModel):
    path: str
    start_line: int
    end_line: int
    content: str
    truncated: bool


class LogLine(BaseModel):
    line: int
    excerpt: str


class ReferencedFile(BaseModel):
    path: str
    line: int | None = None


class HilogSummary(BaseModel):
    line_count: int
    error_lines: list[LogLine] = Field(default_factory=list)
    referenced_files: list[ReferencedFile] = Field(default_factory=list)


class BusinessContextDocument(BaseModel):
    path: str
    title: str
    score: int
    excerpt: str
