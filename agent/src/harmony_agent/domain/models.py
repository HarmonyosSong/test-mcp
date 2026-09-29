from __future__ import annotations

import re
from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


def utc_now() -> datetime:
    return datetime.now(UTC)


class Verdict(StrEnum):
    LOCATED = "located"
    PROBABLE = "probable"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"
    TOOL_ERROR = "tool_error"


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNKNOWN = "unknown"


class EvidenceKind(StrEnum):
    USER = "user"
    LOG = "log"
    SOURCE = "source"
    CONFIG = "config"
    TOOL = "tool"


class Evidence(BaseModel):
    id: str = Field(default_factory=lambda: f"ev-{uuid4().hex[:8]}")
    kind: EvidenceKind
    source: str
    location: str | None = None
    excerpt: str = Field(max_length=2_000)
    supports: str


class RootCauseCandidate(BaseModel):
    title: str
    explanation: str
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)


class EvidenceCitation(BaseModel):
    """模型提交的证据引用:只给 ID、逐字摘录与用途。

    kind/source/location 由运行时从观测账本(或用户输入登记)组装——
    模型不提供这些字段,也就无从与账本不一致。ID 必填且无随机默认。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    excerpt: str = Field(min_length=1, max_length=2_000)
    supports: str = Field(min_length=1, max_length=500)


class ToolEvent(BaseModel):
    id: str = Field(default_factory=lambda: f"tool-{uuid4().hex[:8]}")
    tool: str
    status: str
    summary: str
    arguments_summary: str | None = Field(default=None, max_length=500)
    result_summary: str | None = Field(default=None, max_length=500)
    duration_ms: int | None = None
    created_at: datetime = Field(default_factory=utc_now)


class DiagnosisReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: Verdict
    severity: Severity = Severity.UNKNOWN
    summary: str
    issue_category: str
    likely_location: str | None = None
    root_cause_candidates: list[RootCauseCandidate] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    ruled_out: list[str] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)
    checks_performed: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def require_evidence_for_positive_verdict(self) -> DiagnosisReport:
        # 同一观测允许以不同摘录引用多次(支撑不同论点);纯重复(id+excerpt 相同)
        # 才是注水,按对判重。候选关联仍按 ID 集合语义。
        pairs = [(item.id, item.excerpt.strip()) for item in self.evidence]
        if len(set(pairs)) != len(pairs):
            raise ValueError("duplicate citation of the same observation and excerpt")
        evidence_ids = {item.id for item in self.evidence}
        for candidate in self.root_cause_candidates:
            if not set(candidate.evidence_ids).issubset(evidence_ids):
                raise ValueError("every candidate must be linked to evidence present in the report")
        if self.verdict in {Verdict.LOCATED, Verdict.PROBABLE} and (
            not self.root_cause_candidates
            or any(not candidate.evidence_ids for candidate in self.root_cause_candidates)
        ):
            raise ValueError("positive diagnoses require every candidate linked to evidence")
        return self


class DiagnosisReportDraft(BaseModel):
    """submit_diagnosis_report 的引用式输入:模型只交引用,不交出处字段。

    与 DiagnosisReport 的差异仅在 evidence:这里收 EvidenceCitation(id+excerpt+supports),
    由 EvidenceLedger.resolve_draft 核对摘录并组装成完整 Evidence 后再构造
    DiagnosisReport——持久化与前端仍读原结构,API/UI 无迁移面。
    """

    model_config = ConfigDict(extra="forbid")

    verdict: Verdict
    severity: Severity = Severity.UNKNOWN
    summary: str
    issue_category: str
    likely_location: str | None = None
    root_cause_candidates: list[RootCauseCandidate] = Field(default_factory=list)
    evidence: list[EvidenceCitation] = Field(default_factory=list)
    ruled_out: list[str] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)
    checks_performed: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def require_citations_for_candidates(self) -> DiagnosisReportDraft:
        # 同一观测允许以不同摘录引用多次(支撑不同论点);纯重复(id+excerpt 相同)
        # 按对判重——实测跨轮场景模型需要引用同一观测的两段摘录,旧 unique 约束
        # 把它逼到塞 kind_note 旁路字段(extra_forbidden)再撞 unique,连挂两次。
        pairs = [(item.id, item.excerpt.strip()) for item in self.evidence]
        if len(set(pairs)) != len(pairs):
            raise ValueError("duplicate citation of the same observation and excerpt")
        citation_ids = {item.id for item in self.evidence}
        for candidate in self.root_cause_candidates:
            if not set(candidate.evidence_ids).issubset(citation_ids):
                raise ValueError("every candidate must be linked to a citation in the draft")
        if self.verdict in {Verdict.LOCATED, Verdict.PROBABLE} and (
            not self.root_cause_candidates
            or any(not candidate.evidence_ids for candidate in self.root_cause_candidates)
        ):
            raise ValueError("positive diagnoses require every candidate linked to a citation")
        return self


# 各厂商主流模型的上下文窗口（token）。OpenAI 兼容协议不提供该信息，
# 这里手工维护一份参考值，允许随厂商更新而过期——过期只影响占用百分比展示。
MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    "gpt-5.2": 400_000,
    "gpt-5-mini": 400_000,
    "deepseek-v4-pro": 128_000,
    "deepseek-chat": 128_000,
    "deepseek-reasoner": 128_000,
    "qwen-plus": 131_072,
    "qwen-max": 262_144,
    "qwen-turbo": 131_072,
    "kimi-k3": 262_144,
    "moonshot-v1-8k": 8_192,
    "moonshot-v1-32k": 32_768,
    "glm-5.3": 200_000,
    "glm-4-flash": 128_000,
    "glm-4-plus": 128_000,
    "doubao-seed-2-1-pro-260628": 262_144,
    # Kimi coding 端（api.kimi.com/coding）的模型 ID
    "k3": 1_048_576,
    "k3-256k": 262_144,
    "kimi-for-coding": 262_144,
    "kimi-for-coding-highspeed": 262_144,
}

# 模型参考价格（人民币 / 每百万 token，{"input": ..., "output": ...}）。
# 估算用途：不含缓存命中折扣、阶梯价和套餐价；表里没有的模型前端只显示
# token 数不显示金额。价格随厂商调整而过期，按需手工更新。
MODEL_PRICES: dict[str, dict[str, float]] = {
    "deepseek-chat": {"input": 2.0, "output": 8.0},
    "deepseek-reasoner": {"input": 4.0, "output": 16.0},
    "qwen-plus": {"input": 0.8, "output": 4.8},
    "qwen-max": {"input": 20.0, "output": 60.0},
    "qwen-turbo": {"input": 0.3, "output": 3.0},
    "moonshot-v1-8k": {"input": 12.0, "output": 12.0},
    "moonshot-v1-32k": {"input": 24.0, "output": 24.0},
    "glm-4-flash": {"input": 0.0, "output": 0.0},
    "glm-4-plus": {"input": 50.0, "output": 50.0},
}


class RegisterRepositoryRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    url: str = Field(min_length=8, max_length=2_000)
    default_branch: str | None = Field(default=None, max_length=500)

    @field_validator("name", "url", "default_branch", mode="before")
    @classmethod
    def strip_repository_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("url")
    @classmethod
    def reject_embedded_credentials(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme in {"http", "https", "ssh"}:
            if not parsed.netloc:
                raise ValueError("repository URL must include a host")
            if parsed.password or (parsed.username and parsed.scheme in {"http", "https"}):
                raise ValueError("repository URL must not contain credentials")
            return value
        if parsed.scheme == "file" and parsed.path and not parsed.netloc:
            return value
        if re.fullmatch(r"[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+", value):
            return value
        raise ValueError("repository URL must use HTTP(S), SSH, or SCP syntax")


class RepositoryRecord(BaseModel):
    id: str = Field(default_factory=lambda: f"repo-{uuid4().hex[:10]}")
    name: str
    url: str
    default_branch: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class RepositoryBranch(BaseModel):
    name: str
    commit: str


class CreateSnapshotRequest(BaseModel):
    branch: str = Field(min_length=1, max_length=500)

    @field_validator("branch", mode="before")
    @classmethod
    def strip_branch(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class RepositorySnapshot(BaseModel):
    repository_id: str
    repository_name: str
    requested_ref: str
    resolved_commit: str
    workspace_path: str
    created_at: datetime = Field(default_factory=utc_now)


class SkillSummary(BaseModel):
    name: str
    description: str
    version: str
    stage: str


class MetaResponse(BaseModel):
    mode: str
    model: str | None
    skills: list[SkillSummary]
    mcp_tools: list[str]
    constraints: list[str]
    # 模型名 -> 上下文窗口 token 数；协议无法查询，由内置表维护，允许过期。
    # 查不到时前端只显示 token 绝对值，不显示百分比。
    context_windows: dict[str, int] = Field(default_factory=dict)
    # 模型名 -> 参考价格（人民币/百万 token，input/output）。估算用途，
    # 查不到的模型前端不显示金额。
    model_prices: dict[str, dict[str, float]] = Field(default_factory=dict)


class ModelProviderPreset(BaseModel):
    id: str
    name: str
    base_url: str
    default_model: str
    suggested_models: list[str] = Field(default_factory=list)
    requires_api_key: bool = True
    api_key_env: str | None = None
    note: str = ""


class ModelConfigRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=50)
    model_name: str = Field(min_length=1, max_length=200)
    base_url: str | None = Field(default=None, max_length=2_000)
    api_key: SecretStr | None = None
    no_api_key: bool = False
    compatibility_mode: Literal["standard", "relaxed"] = "standard"

    @field_validator("provider", "model_name", mode="before")
    @classmethod
    def strip_required_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("base_url", mode="before")
    @classmethod
    def validate_base_url(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        stripped = value.strip()
        if not stripped:
            return None
        parsed = urlsplit(stripped)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password:
            raise ValueError("base_url must not contain credentials")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain a query or fragment")
        normalized_path = parsed.path.rstrip("/")
        return urlunsplit((parsed.scheme, parsed.netloc, normalized_path, "", ""))

    @field_validator("api_key")
    @classmethod
    def limit_api_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) > 4_096:
            raise ValueError("api_key is too long")
        return value

    @model_validator(mode="after")
    def validate_key_mode(self) -> ModelConfigRequest:
        if self.no_api_key and self.api_key and self.api_key.get_secret_value():
            raise ValueError("api_key must be empty when no_api_key is enabled")
        return self


class AvailableModelsRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=50)
    base_url: str | None = Field(default=None, max_length=2_000)
    api_key: SecretStr | None = None
    no_api_key: bool = False


class ModelStatus(BaseModel):
    mode: str
    configured: bool
    provider: str | None = None
    provider_name: str | None = None
    model_name: str | None = None
    base_url: str | None = None
    api_key_configured: bool = False
    source: str | None = None
    compatibility_mode: str = "standard"


class ModelConnectionResult(BaseModel):
    ok: bool
    provider: str
    model_name: str
    latency_ms: int
    response_preview: str
