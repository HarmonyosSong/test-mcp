from __future__ import annotations

from pydantic import BaseModel, Field

# 读取协议的字符预算(实验值):默认值与硬上限。
# 行号与格式开销计入预算;单行连硬上限都放不下时按 line_too_long 结构化披露。
DEFAULT_READ_CHARS = 6_000
MAX_READ_CHARS = 12_000
# 单次读取的行数窗口(独立于字符预算,继续生效,字符预算不能绕过它)。
MAX_READ_LINES = 400
# 搜索默认小结果集与上限:先给少量命中,不够再用 next_cursor 续查。
DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 200


class SearchMatch(BaseModel):
    path: str
    line: int
    excerpt: str


class SearchPage(BaseModel):
    """有界搜索页:默认小结果集,披露检索范围与稳定的续查游标。

    - truncated 为 true 表示达到结果数上限,可能还有未交付命中;
      把 next_cursor 原样带回(保持同一 query/file_glob)续查下一页。
    - scan_limit_reached 为 true 表示检索范围被 max_search_files 截断,
      不得据局部无命中声称全仓不存在,应缩小 file_glob 再查。
    - next_cursor 绑定 query/file_glob/工作区快照,不能跨条件复用。
    """

    query: str
    file_glob: str
    matches: list[SearchMatch] = Field(default_factory=list)
    truncated: bool = False
    scanned_files: int = 0
    scan_limit_reached: bool = False
    next_cursor: str | None = None


class FileContent(BaseModel):
    """一次有界读取的交付页。

    - start_line/end_line 是实际完整交付的行区间;requested_end_line 是请求的截止行。
    - truncated 只表示「请求范围未完整交付」,不再沿用「文件后面还有内容」的旧含义;
      文件是否还有后文看 has_more_in_file。
    - next_line 仅在请求范围仍有缺段时给出续读起点;请求已读完为 None(即使文件还有后文)。
    - 无交付行时 end_line = start_line - 1(空页),配合 truncation_reason/skipped_lines 解读。
    """

    path: str
    start_line: int
    end_line: int
    requested_end_line: int
    total_lines: int
    content: str
    truncated: bool
    next_line: int | None = None
    has_more_in_file: bool = False
    # character_budget:字符预算耗尽;line_range_limit:超 400 行窗口;
    # line_too_long:单行超过硬上限,未作为完整观测交付
    truncation_reason: str | None = None
    skipped_lines: list[int] = Field(default_factory=list)


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
