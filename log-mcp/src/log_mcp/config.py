"""配置加载：环境变量 > 配置文件 > 内置默认。

凭据与运行参数集中在 `log-mcp/config/log-mcp.local.json`（不提交 git）。
容器环境通过 `LOG_MCP_*` 环境变量覆盖文件值，便于平台 secret 注入。

日志中心与云日志共用同一网关入口（baseUrl + appid/appsecret），按环境区分：
  prod → https://logcenter-api.tal.com/api
  test → https://logcenter-api-test.tal.com/api
云日志仅额外持有 vendor + defaults（region/account/collection）。

`env` 默认 `test`；线上用 `LOG_MCP_ENV=prod` 或配置文件 `"env": "prod"`。
环境名只认 `prod` / `test`，无其它别名。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, SecretStr

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_TIMEOUT_MS = 30000
# 默认 test：本地误打生产的风险更低；线上必须显式覆盖为 prod
DEFAULT_ENV = "test"

# 网关地址按环境固定
DEFAULT_GATEWAY_BASE_URLS = {
    "prod": "https://logcenter-api.tal.com/api",
    "test": "https://logcenter-api-test.tal.com/api",
}

DEFAULT_CLOUDLOG_VENDOR = "aliyun"
DEFAULT_CLOUDLOG_REGION = "cn-beijing"
DEFAULT_CLOUDLOG_ACCOUNT = "1743276692096170"
DEFAULT_CLOUDLOG_COLLECTION = "pysy-front-log"

CONFIG_FILENAME = "log-mcp.local.json"
CONFIG_DIR_DEFAULT = Path(__file__).resolve().parents[2] / "config"


def normalize_env(env: str | None) -> str:
    """归一化环境名；只认 `prod` / `test`，其它一律回退 test。"""
    if env is None:
        return "test"
    key = str(env).strip().lower()
    if key == "prod":
        return "prod"
    return "test"


class GatewayCredential(BaseModel):
    """单个环境的共用网关入口：baseUrl + appid/appsecret。

    日志中心与云日志都走这套凭据；`baseUrl` 可省略，省略时用该环境内置默认。
    """

    base_url: str = Field(default="", alias="baseUrl")
    appid: str = ""
    appsecret: SecretStr = SecretStr("")


class GatewayConfig(BaseModel):
    """按环境的共用网关配置。键名：`prod` / `test`。"""

    prod: GatewayCredential = Field(default_factory=GatewayCredential)
    test: GatewayCredential = Field(default_factory=GatewayCredential)

    def credential(self, env: str) -> GatewayCredential:
        """按 env 选择凭据；未知 env 回退到 test。"""
        if normalize_env(env) == "prod":
            return self.prod
        return self.test

    def base_url(self, env: str) -> str:
        """按 env 选择网关；凭据未填 baseUrl 时用内置默认。"""
        resolved = normalize_env(env)
        cred = self.credential(resolved)
        if cred.base_url:
            return cred.base_url.rstrip("/")
        return DEFAULT_GATEWAY_BASE_URLS[resolved]


class CloudLogDefaults(BaseModel):
    """云日志 5 元组中可固定的 4 个坐标，启动时注入工具 schema default。"""

    region: str = DEFAULT_CLOUDLOG_REGION
    account: str = DEFAULT_CLOUDLOG_ACCOUNT
    collection: str = DEFAULT_CLOUDLOG_COLLECTION


class CloudLogConfig(BaseModel):
    """云日志专属配置：厂商 + 默认坐标。

    网关与凭据复用 `gateway[env]`，不在此重复配置。
    """

    vendor: str = DEFAULT_CLOUDLOG_VENDOR
    defaults: CloudLogDefaults = Field(default_factory=CloudLogDefaults)


class AuthConfig(BaseModel):
    """鉴权开关；仅本地回环生效。"""

    disabled: bool = False


class Settings(BaseModel):
    """运行参数；环境变量优先于配置文件。

    `env`：启动默认环境（可用 `LOG_MCP_ENV` / 配置文件覆盖），
    作为日志中心工具 `env` 入参缺省值，以及云日志凭据/网关选择依据。
    取值只认 `prod` / `test`。
    """

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    env: str = DEFAULT_ENV
    data_root: str = ""
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    auth: AuthConfig = Field(default_factory=AuthConfig)
    gateway: GatewayConfig = Field(default_factory=GatewayConfig)
    cloudlog: CloudLogConfig = Field(default_factory=CloudLogConfig)

    @property
    def default_env(self) -> str:
        """归一化后的启动默认环境。"""
        return normalize_env(self.env)

    @property
    def data_root_path(self) -> Path:
        """解析数据根。

        优先级：显式 data_root > ${HARMONY_AGENT_DATA_ROOT}/log-mcp >
        复用项目根 .data（troubleshoot-odyssey/.data/log-mcp）。
        """
        if self.data_root:
            return Path(self.data_root)
        base = os.environ.get("HARMONY_AGENT_DATA_ROOT")
        if base:
            return Path(base) / "log-mcp"
        project_root = Path(__file__).resolve().parents[3]
        return project_root / ".data" / "log-mcp"


def _read_config_file(path: Path) -> dict[str, Any]:
    """读取 JSON 配置文件；不存在返回空 dict。"""
    if not path.is_file():
        return {}
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        return {}
    return json.loads(raw)


def _merge_env_block(target: dict[str, Any], key: str) -> dict[str, Any]:
    """确保 gateway.prod / test 子 dict 可写。"""
    block = dict(target.get(key) or {})
    target[key] = block
    return block


def _normalize_raw_config(raw: dict[str, Any]) -> dict[str, Any]:
    """规范化文件配置：旧版 `logcenter` 键迁移为 `gateway`，剥掉无效顶层 baseUrl。

    旧键名 `gateway.production` 自动迁到 `gateway.prod`（只为兼容旧文件，对外统一用 prod）。
    """
    out = dict(raw)
    # 兼容旧配置键 logcenter → gateway
    if "gateway" not in out and isinstance(out.get("logcenter"), dict):
        out["gateway"] = out.pop("logcenter")
    else:
        out.pop("logcenter", None)

    if isinstance(out.get("gateway"), dict):
        gateway = dict(out["gateway"])
        gateway.pop("baseUrl", None)
        if "prod" not in gateway and isinstance(gateway.get("production"), dict):
            gateway["prod"] = gateway.pop("production")
        else:
            gateway.pop("production", None)
        out["gateway"] = gateway

    if isinstance(out.get("cloudlog"), dict):
        cloudlog = dict(out["cloudlog"])
        cloudlog.pop("baseUrl", None)
        out["cloudlog"] = cloudlog
    return out


def _env_overrides(raw: dict[str, Any]) -> dict[str, Any]:
    """把 `LOG_MCP_*` 环境变量叠到配置 dict 上（可覆盖文件默认值）。"""
    overrides: dict[str, Any] = {}

    if val := os.environ.get("LOG_MCP_HOST"):
        overrides["host"] = val
    if val := os.environ.get("LOG_MCP_PORT"):
        overrides["port"] = int(val)
    # 覆盖默认 test：线上/容器注入 LOG_MCP_ENV=prod
    if val := os.environ.get("LOG_MCP_ENV"):
        overrides["env"] = val
    if val := os.environ.get("LOG_MCP_DATA_ROOT"):
        overrides["data_root"] = val
    if val := os.environ.get("LOG_MCP_TIMEOUT_MS"):
        overrides["timeout_ms"] = int(val)
    if val := os.environ.get("LOG_MCP_AUTH_DISABLED"):
        overrides["auth"] = {"disabled": val.lower() in {"1", "true", "yes"}}

    gateway = dict(raw.get("gateway") or {})
    prod = _merge_env_block(gateway, "prod")
    test = _merge_env_block(gateway, "test")

    if val := os.environ.get("LOG_MCP_PROD_APPID"):
        prod["appid"] = val
    if val := os.environ.get("LOG_MCP_PROD_APPSECRET"):
        prod["appsecret"] = val
    if val := os.environ.get("LOG_MCP_TEST_APPID"):
        test["appid"] = val
    if val := os.environ.get("LOG_MCP_TEST_APPSECRET"):
        test["appsecret"] = val
    # 网关 URL 覆盖；LOG_MCP_LOGCENTER_BASE_URL 兼容旧名 → prod
    if val := os.environ.get("LOG_MCP_PROD_BASE_URL") or os.environ.get(
        "LOG_MCP_LOGCENTER_BASE_URL"
    ):
        prod["baseUrl"] = val
    if val := os.environ.get("LOG_MCP_TEST_BASE_URL"):
        test["baseUrl"] = val
    if gateway:
        overrides["gateway"] = gateway

    cloudlog = dict(raw.get("cloudlog") or {})
    if val := os.environ.get("LOG_MCP_CLOUDLOG_VENDOR"):
        cloudlog["vendor"] = val
    if val := os.environ.get("LOG_MCP_CLOUDLOG_REGION"):
        cloudlog.setdefault("defaults", {})["region"] = val
    if val := os.environ.get("LOG_MCP_CLOUDLOG_ACCOUNT"):
        cloudlog.setdefault("defaults", {})["account"] = val
    if val := os.environ.get("LOG_MCP_CLOUDLOG_COLLECTION"):
        cloudlog.setdefault("defaults", {})["collection"] = val
    if cloudlog:
        overrides["cloudlog"] = cloudlog

    return overrides


def load_settings(config_dir: Path | None = None) -> Settings:
    """按 env > file > default 顺序装配 Settings。"""
    directory = config_dir or CONFIG_DIR_DEFAULT
    raw = _normalize_raw_config(_read_config_file(directory / CONFIG_FILENAME))
    merged = {**raw, **_env_overrides(raw)}
    return Settings.model_validate(merged)


# 向后兼容别名（测试/外部若仍引用旧名）
DEFAULT_LOGCENTER_BASE_URLS = DEFAULT_GATEWAY_BASE_URLS
LogCenterCredential = GatewayCredential
LogCenterConfig = GatewayConfig
