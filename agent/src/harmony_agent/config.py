from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="HARMONY_AGENT_",
        extra="ignore",
    )

    app_name: str = "Harmony Triage"
    mode: Literal["demo", "model"] = "demo"
    model: str = "openai:gpt-5.2"
    conversations_data_file: Path = Path(".data/conversations.json")
    model_config_file: Path = Path(".data/model-config.json")
    repository_data_file: Path = Path(".data/repositories.json")
    git_mirror_dir: Path = Path(".data/git-mirrors")
    snapshot_dir: Path = Path(".data/workspaces")
    git_timeout_seconds: int = Field(default=120, ge=10, le=600)
    skills_dir: Path = Path("skills")
    knowledge_root: Path = Path("knowledge")
    # 查询日志路径：None=默认 .data/knowledge-queries.jsonl；"off"/空串=关闭。
    # "off" 语义的解析只在 mcp_server 的 resolve_query_log_path 里，这里原样透传。
    knowledge_query_log: str | None = None
    dev_knowledge_config: Path | None = None
    tool_failure_limit: int = Field(default=10, ge=1, le=100)
    tool_call_limit: int = Field(default=30, ge=1, le=100)
    tool_no_progress_limit: int = Field(default=4, ge=1, le=20)
    allowed_roots: Annotated[list[Path], NoDecode] = Field(default_factory=lambda: [Path.cwd()])
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )

    @field_validator("allowed_roots", "cors_origins", mode="before")
    @classmethod
    def split_comma_separated(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("allowed_roots")
    @classmethod
    def resolve_allowed_roots(cls, value: list[Path]) -> list[Path]:
        return [path.expanduser().resolve() for path in value]

    @property
    def model_enabled(self) -> bool:
        return self.mode == "model"


@lru_cache
def get_settings() -> Settings:
    return Settings()
