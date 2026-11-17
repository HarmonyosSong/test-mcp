"""配置：gateway 共用凭据 + env 默认 test 且可覆盖（仅环境变量）。"""

from __future__ import annotations

from log_mcp.config import (
    DEFAULT_ENV,
    DEFAULT_GATEWAY_BASE_URLS,
    Settings,
    load_settings,
    normalize_env,
)
from log_mcp.server import _build_factories


def test_default_env_is_test() -> None:
    assert DEFAULT_ENV == "test"
    assert Settings().default_env == "test"


def test_default_base_urls_by_env() -> None:
    settings = Settings()
    assert settings.gateway.base_url("prod") == DEFAULT_GATEWAY_BASE_URLS["prod"]
    assert settings.gateway.base_url("test") == DEFAULT_GATEWAY_BASE_URLS["test"]
    assert "logcenter-api.tal.com" in settings.gateway.base_url("prod")
    assert "logcenter-api-test.tal.com" in settings.gateway.base_url("test")


def test_explicit_base_url_override() -> None:
    settings = Settings(
        gateway={
            "prod": {"baseUrl": "https://prod.example/api", "appid": "a", "appsecret": "s"},
            "test": {"baseUrl": "https://test.example/api", "appid": "a", "appsecret": "s"},
        }
    )
    assert settings.gateway.base_url("prod") == "https://prod.example/api"
    assert settings.gateway.base_url("test") == "https://test.example/api"


def test_factory_shares_gateway_between_sides(tmp_path) -> None:
    settings = Settings(
        env="test",
        data_root=str(tmp_path),
        gateway={
            "prod": {
                "baseUrl": "https://logcenter-api.tal.com/api",
                "appid": "prod-id",
                "appsecret": "prod-secret",
            },
            "test": {
                "baseUrl": "https://logcenter-api-test.tal.com/api",
                "appid": "test-id",
                "appsecret": "test-secret",
            },
        },
    )
    logcenter_factory, cloudlog_factory = _build_factories(settings)
    prod = logcenter_factory("prod")
    test = logcenter_factory("test")
    assert prod.base_url == "https://logcenter-api.tal.com/api"
    assert test.base_url == "https://logcenter-api-test.tal.com/api"
    cloud = cloudlog_factory()
    assert cloud.base_url == "https://logcenter-api-test.tal.com/api"
    assert cloud.cred.appid == "test-id"


def test_log_mcp_env_overrides_default_test(monkeypatch) -> None:
    monkeypatch.setattr("log_mcp.config._load_root_dotenv", lambda: None)
    monkeypatch.setenv("LOG_MCP_ENV", "prod")
    monkeypatch.setenv("LOG_MCP_PROD_APPID", "p")
    monkeypatch.setenv("LOG_MCP_PROD_APPSECRET", "ps")
    monkeypatch.setenv("LOG_MCP_TEST_APPID", "t")
    monkeypatch.setenv("LOG_MCP_TEST_APPSECRET", "ts")
    settings = load_settings()
    assert settings.default_env == "prod"
    assert settings.gateway.prod.appid == "p"
    assert settings.gateway.test.appid == "t"


def test_default_env_without_override(monkeypatch) -> None:
    monkeypatch.setattr("log_mcp.config._load_root_dotenv", lambda: None)
    monkeypatch.delenv("LOG_MCP_ENV", raising=False)
    settings = load_settings()
    assert settings.default_env == "test"


def test_gateway_urls_from_env(monkeypatch) -> None:
    monkeypatch.setattr("log_mcp.config._load_root_dotenv", lambda: None)
    monkeypatch.delenv("LOG_MCP_LOGCENTER_BASE_URL", raising=False)
    monkeypatch.setenv("LOG_MCP_PROD_BASE_URL", "https://prod.example/api")
    monkeypatch.setenv("LOG_MCP_TEST_BASE_URL", "https://test.example/api")
    monkeypatch.setenv("LOG_MCP_PROD_APPID", "p")
    monkeypatch.setenv("LOG_MCP_PROD_APPSECRET", "ps")
    monkeypatch.setenv("LOG_MCP_TEST_APPID", "t")
    monkeypatch.setenv("LOG_MCP_TEST_APPSECRET", "ts")
    settings = load_settings()
    assert settings.gateway.base_url("prod") == "https://prod.example/api"
    assert settings.gateway.base_url("test") == "https://test.example/api"


def test_legacy_logcenter_base_url_maps_to_prod(monkeypatch) -> None:
    monkeypatch.setattr("log_mcp.config._load_root_dotenv", lambda: None)
    monkeypatch.delenv("LOG_MCP_PROD_BASE_URL", raising=False)
    monkeypatch.setenv("LOG_MCP_LOGCENTER_BASE_URL", "https://legacy-prod.example/api")
    monkeypatch.setenv("LOG_MCP_PROD_APPID", "p")
    monkeypatch.setenv("LOG_MCP_PROD_APPSECRET", "ps")
    settings = load_settings()
    assert settings.gateway.base_url("prod") == "https://legacy-prod.example/api"
    assert settings.gateway.base_url("test") == DEFAULT_GATEWAY_BASE_URLS["test"]

def test_normalize_env() -> None:
    assert normalize_env("test") == "test"
    assert normalize_env("prod") == "prod"
    assert normalize_env(None) == "test"
    assert normalize_env("other") == "test"
    # 不再认 production 等别名
    assert normalize_env("production") == "test"


def test_logs_dir_under_data_root(tmp_path) -> None:
    settings = Settings(data_root=str(tmp_path))
    assert settings.logs_dir == tmp_path / "logs"
