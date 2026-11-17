"""配置加载：环境变量（含项目根 .env）> 内置默认。

统一维护在 `troubleshoot-odyssey/.env`，前缀 `LOG_MCP_*`。
不再使用 `log-mcp/config/*.json`。

日志中心与云日志共用同一网关入口（baseUrl + appid/appsecret），按环境区分：
  prod → https://logcenter-api.tal.com/api
  test → https://logcenter-api-test.tal.com/api
云日志仅额外持有 vendor + defaults（region/account/collection）。

`env` 默认 `test`；线上用 `LOG_MCP_ENV=prod`。
环境名只认 `prod` / `test`，无其它别名。
"""

from __future__ import annotations

import os
from pathlib import Path

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

# log-mcp/src/log_mcp/config.py → parents[3] = troubleshoot-odyssey 项目根
PROJECT_ROOT = Path(__file__).resolve().parents[3]


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

    日志中心与云日志都走这套凭据；`base_url` 可省略，省略时用该环境内置默认。
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
    """运行参数；全部来自环境变量 / 内置默认。

    `env`：启动默认环境（`LOG_MCP_ENV`），
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
        return PROJECT_ROOT / ".data" / "log-mcp"

    @property
    def logs_dir(self) -> Path:
        """调用/运行日志目录：`<data_root>/logs`，按日文件落盘。"""
        return self.data_root_path / "logs"


def _load_root_dotenv() -> None:
    """从项目根 `.env` 注入未设置的环境变量（不覆盖进程已有值）。"""
    env_path = PROJECT_ROOT / ".env"
    if not env_path.is_file():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        # 无 python-dotenv 时手写解析，行为对齐 runtime/config.ts
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[key] = value
        return
    load_dotenv(env_path, override=False)


def _env_to_settings() -> dict:
    """把 `LOG_MCP_*` 环境变量装配成 Settings 入参 dict。"""
    raw: dict = {}

    if val := os.environ.get("LOG_MCP_HOST"):
        raw["host"] = val
    if val := os.environ.get("LOG_MCP_PORT"):
        raw["port"] = int(val)
    if val := os.environ.get("LOG_MCP_ENV"):
        raw["env"] = val
    if val := os.environ.get("LOG_MCP_DATA_ROOT"):
        raw["data_root"] = val
    if val := os.environ.get("LOG_MCP_TIMEOUT_MS"):
        raw["timeout_ms"] = int(val)
    if val := os.environ.get("LOG_MCP_AUTH_DISABLED"):
        raw["auth"] = {"disabled": val.lower() in {"1", "true", "yes"}}

    prod: dict = {}
    test: dict = {}
    if val := os.environ.get("LOG_MCP_PROD_APPID"):
        prod["appid"] = val
    if val := os.environ.get("LOG_MCP_PROD_APPSECRET"):
        prod["appsecret"] = val
    if val := os.environ.get("LOG_MCP_TEST_APPID"):
        test["appid"] = val
    if val := os.environ.get("LOG_MCP_TEST_APPSECRET"):
        test["appsecret"] = val
    if val := os.environ.get("LOG_MCP_PROD_BASE_URL") or os.environ.get(
        "LOG_MCP_LOGCENTER_BASE_URL"
    ):
        prod["baseUrl"] = val
    if val := os.environ.get("LOG_MCP_TEST_BASE_URL"):
        test["baseUrl"] = val
    if prod or test:
        raw["gateway"] = {"prod": prod, "test": test}

    cloudlog: dict = {}
    defaults: dict = {}
    if val := os.environ.get("LOG_MCP_CLOUDLOG_VENDOR"):
        cloudlog["vendor"] = val
    if val := os.environ.get("LOG_MCP_CLOUDLOG_REGION"):
        defaults["region"] = val
    if val := os.environ.get("LOG_MCP_CLOUDLOG_ACCOUNT"):
        defaults["account"] = val
    if val := os.environ.get("LOG_MCP_CLOUDLOG_COLLECTION"):
        defaults["collection"] = val
    if defaults:
        cloudlog["defaults"] = defaults
    if cloudlog:
        raw["cloudlog"] = cloudlog

    return raw


def load_settings() -> Settings:
    """按 env（含根 .env）> 内置默认 装配 Settings。"""
    _load_root_dotenv()
    return Settings.model_validate(_env_to_settings())


# 向后兼容别名（测试/外部若仍引用旧名）
DEFAULT_LOGCENTER_BASE_URLS = DEFAULT_GATEWAY_BASE_URLS
LogCenterCredential = GatewayCredential
LogCenterConfig = GatewayConfig
