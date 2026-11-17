"""配置：gateway 共用凭据 + env 默认 test 且可覆盖。"""

from __future__ import annotations

import json
from pathlib import Path

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


def test_log_mcp_env_overrides_default_test(tmp_path: Path, monkeypatch) -> None:
    cfg = tmp_path / "log-mcp.local.json"
    cfg.write_text(
        json.dumps(
            {
                "gateway": {
                    "prod": {"appid": "p", "appsecret": "ps"},
                    "test": {"appid": "t", "appsecret": "ts"},
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LOG_MCP_ENV", "prod")
    settings = load_settings(tmp_path)
    assert settings.default_env == "prod"


def test_file_env_overrides_default_without_env_var(tmp_path: Path, monkeypatch) -> None:
    cfg = tmp_path / "log-mcp.local.json"
    cfg.write_text(
        json.dumps(
            {
                "env": "prod",
                "gateway": {
                    "prod": {"appid": "p", "appsecret": "ps"},
                    "test": {"appid": "t", "appsecret": "ts"},
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("LOG_MCP_ENV", raising=False)
    settings = load_settings(tmp_path)
    assert settings.default_env == "prod"


def test_legacy_logcenter_key_migrates_to_gateway(tmp_path: Path, monkeypatch) -> None:
    cfg = tmp_path / "log-mcp.local.json"
    cfg.write_text(
        json.dumps(
            {
                "env": "test",
                "logcenter": {
                    "baseUrl": "https://should-be-ignored/api",
                    "prod": {"appid": "p", "appsecret": "ps"},
                    "test": {
                        "baseUrl": "https://logcenter-api-test.tal.com/api",
                        "appid": "t",
                        "appsecret": "ts",
                    },
                },
                "cloudlog": {"baseUrl": "https://also-ignored/api", "vendor": "aliyun"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("LOG_MCP_ENV", raising=False)
    monkeypatch.delenv("LOG_MCP_LOGCENTER_BASE_URL", raising=False)
    settings = load_settings(tmp_path)
    assert settings.gateway.credential("test").appid == "t"
    assert settings.gateway.base_url("test") == "https://logcenter-api-test.tal.com/api"
    assert settings.gateway.base_url("prod") == DEFAULT_GATEWAY_BASE_URLS["prod"]


def test_normalize_env() -> None:
    assert normalize_env("test") == "test"
    assert normalize_env("prod") == "prod"
    assert normalize_env(None) == "test"
    assert normalize_env("other") == "test"
    # 不再认 production 等别名
    assert normalize_env("production") == "test"


def test_legacy_gateway_production_key_migrates_to_prod(tmp_path: Path, monkeypatch) -> None:
    cfg = tmp_path / "log-mcp.local.json"
    cfg.write_text(
        json.dumps(
            {
                "env": "prod",
                "gateway": {
                    "production": {"appid": "legacy-p", "appsecret": "ps"},
                    "test": {"appid": "t", "appsecret": "ts"},
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("LOG_MCP_ENV", raising=False)
    settings = load_settings(tmp_path)
    assert settings.default_env == "prod"
    assert settings.gateway.prod.appid == "legacy-p"
