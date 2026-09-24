from __future__ import annotations

from datetime import date
from enum import StrEnum

from pydantic import BaseModel, Field


class KnowledgeKind(StrEnum):
    SYMPTOM = "symptom"
    PLATFORM_FACT = "platform-fact"
    MAPPING = "mapping"
    EXPERIENCE = "experience"


class Authority(StrEnum):
    OFFICIAL = "official"
    INTERNAL_SOP = "internal-sop"
    CODE = "code"
    TICKET = "ticket"
    AUTO = "auto"


class End(StrEnum):
    HARMONY = "harmony"
    IOS = "ios"
    ANDROID = "android"


class SearchScope(StrEnum):
    SYMPTOM = "symptom"
    FACT = "fact"
    ALL = "all"


class KnowledgeEntry(BaseModel):
    name: str
    kind: KnowledgeKind
    title: str
    summary: str
    body: str
    applies_to: list[End] = Field(default_factory=list)
    authority: Authority
    aliases: list[str] = Field(default_factory=list)
    domains: list[str] = Field(default_factory=list)
    applicable_versions: str | None = None
    updated_at: date | None = None
    verified_at: date | None = None
    references: list[str] = Field(default_factory=list)
    source_path: str

    @property
    def match_terms(self) -> list[str]:
        """检索匹配用的候选短语。

        现象条目用 symptom + 别名，事实条目用标题 + description + 别名。事实的 description 是
        给人读的长句，单靠它匹配会让短查询全部落到阈值之下；标题是关键词密集的短句，别名则用来
        补上用户会怎么说。
        """
        terms = [self.summary, self.title, *self.aliases]
        return list(dict.fromkeys(term for term in terms if term))


class SearchHit(BaseModel):
    name: str
    kind: KnowledgeKind
    summary: str
    score: float
    authority: Authority
    applies_to: list[End]
    domains: list[str] = Field(default_factory=list)
    domain_match: bool | None = Field(
        default=None,
        description="是否命中候选域或 shared；未指定域时为 null。仅用于排序，不判断证据可信度。",
    )
    end_match: bool = Field(
        description="条目是否适用于检索时给出的端。为 false 时只能作为线索，不能作为结论证据。"
    )
    version_match: bool = Field(
        description="条目版本区间是否覆盖检索时给出的版本。为 false 时只能作为线索。"
    )
    matched_on: str = Field(description="命中的短语")
    references: list[str] = Field(default_factory=list)


class KnowledgeDocument(BaseModel):
    name: str
    kind: KnowledgeKind
    summary: str
    applies_to: list[End]
    domains: list[str] = Field(default_factory=list)
    authority: Authority
    applicable_versions: str | None = None
    updated_at: date | None = None
    verified_at: date | None = None
    references: list[str] = Field(default_factory=list)
    body: str


class SymptomSummary(BaseModel):
    name: str
    symptom: str
    aliases: list[str] = Field(default_factory=list)
    applies_to: list[End]
    domains: list[str] = Field(default_factory=list)
    verified_at: date | None = None


class KnowledgePreview(KnowledgeDocument):
    truncated: bool = False
    leads_only: bool = True


class KnowledgePage(KnowledgeDocument):
    offset: int
    next_offset: int | None
    total_chars: int
    truncated: bool


class KnowledgeLookup(BaseModel):
    scope_used: SearchScope
    hits: list[SearchHit]
    documents: list[KnowledgePreview]
    omitted_references: list[str] = Field(default_factory=list)
