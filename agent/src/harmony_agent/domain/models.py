from __future__ import annotations

import re
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


def utc_now() -> datetime:
    return datetime.now(UTC)


class CaseStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class StageKey(StrEnum):
    INTAKE = "intake"
    LOCATE = "locate"
    INVESTIGATE = "investigate"
    DIAGNOSE = "diagnose"


class StageStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


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


class StageState(BaseModel):
    key: StageKey
    label: str
    status: StageStatus = StageStatus.PENDING
    summary: str = ""
    started_at: datetime | None = None
    completed_at: datetime | None = None


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


class ToolEvent(BaseModel):
    id: str = Field(default_factory=lambda: f"tool-{uuid4().hex[:8]}")
    tool: str
    status: str
    summary: str
    # 以下为可选的审计字段，当前仅聊天路径写入；案例诊断路径保持 None，
    # 以保证既有 cases.json 数据形态不变。
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
        if self.verdict in {Verdict.LOCATED, Verdict.PROBABLE}:
            evidence_ids = {item.id for item in self.evidence}
            linked = {
                evidence_id
                for candidate in self.root_cause_candidates
                for evidence_id in candidate.evidence_ids
            }
            if not self.root_cause_candidates or not linked.intersection(evidence_ids):
                raise ValueError("positive diagnoses require a candidate linked to evidence")
        return self


STAGE_LABELS: dict[StageKey, str] = {
    StageKey.INTAKE: "接收问题",
    StageKey.LOCATE: "定位范围",
    StageKey.INVESTIGATE: "验证假设",
    StageKey.DIAGNOSE: "生成诊断",
}

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


def default_stages() -> list[StageState]:
    return [StageState(key=key, label=label) for key, label in STAGE_LABELS.items()]


class CreateCaseRequest(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    description: str = Field(min_length=2, max_length=5_000)
    evidence: str = Field(default="", max_length=40_000)
    workspace_path: str | None = Field(default=None, max_length=2_000)
    repository_id: str | None = Field(default=None, max_length=100)
    branch: str | None = Field(default=None, max_length=500)

    @field_validator("title", "description", "evidence", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("workspace_path", mode="before")
    @classmethod
    def normalize_workspace(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("repository_id", "branch", mode="before")
    @classmethod
    def normalize_repository_fields(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @model_validator(mode="after")
    def validate_source(self) -> CreateCaseRequest:
        if bool(self.repository_id) != bool(self.branch):
            raise ValueError("repository_id and branch must be provided together")
        if self.workspace_path and self.repository_id:
            raise ValueError("workspace_path and repository_id are mutually exclusive")
        return self


class DiagnosisCase(BaseModel):
    id: str = Field(default_factory=lambda: f"case-{uuid4().hex[:10]}")
    title: str
    description: str
    input_evidence: str = ""
    workspace_path: str | None = None
    repository_id: str | None = None
    repository_name: str | None = None
    requested_ref: str | None = None
    resolved_commit: str | None = None
    status: CaseStatus = CaseStatus.QUEUED
    stages: list[StageState] = Field(default_factory=default_stages)
    report: DiagnosisReport | None = None
    tool_events: list[ToolEvent] = Field(default_factory=list)
    error: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @classmethod
    def from_request(
        cls,
        request: CreateCaseRequest,
        workspace: Path | None,
        *,
        repository_name: str | None = None,
        resolved_commit: str | None = None,
    ) -> DiagnosisCase:
        return cls(
            title=request.title,
            description=request.description,
            input_evidence=request.evidence,
            workspace_path=str(workspace) if workspace else None,
            repository_id=request.repository_id,
            repository_name=repository_name,
            requested_ref=request.branch,
            resolved_commit=resolved_commit,
        )


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
