from pathlib import Path

import pytest
from pydantic import ValidationError
from pydantic_ai.models.openai import OpenAIChatModel

from harmony_agent.config import Settings
from harmony_agent.domain import ModelConfigRequest
from harmony_agent.runtimes.model_gateway import ModelConfigurationError, ModelGateway


def make_gateway(tmp_path: Path) -> ModelGateway:
    return ModelGateway(
        Settings(
            mode="demo",
            data_file=tmp_path / "cases.json",
            model_config_file=tmp_path / "model-config.json",
            allowed_roots=[tmp_path],
        )
    )


async def test_runtime_configuration_never_exposes_api_key(tmp_path: Path) -> None:
    gateway = make_gateway(tmp_path)
    secret = "sk-test-secret-value"

    status = await gateway.configure(
        ModelConfigRequest(
            provider="deepseek",
            model_name="deepseek-chat",
            api_key=secret,
        )
    )
    model = await gateway.get_model()

    assert status.mode == "model"
    assert status.api_key_configured is True
    assert secret not in status.model_dump_json()
    assert isinstance(model, OpenAIChatModel)
    assert model.model_name == "deepseek-chat"
    await gateway.close()


async def test_custom_local_provider_can_run_without_api_key(tmp_path: Path) -> None:
    gateway = make_gateway(tmp_path)

    status = await gateway.configure(
        ModelConfigRequest(
            provider="custom",
            model_name="qwen-local",
            base_url="http://127.0.0.1:11434/v1/",
            no_api_key=True,
            compatibility_mode="relaxed",
        )
    )

    assert status.base_url == "http://127.0.0.1:11434/v1"
    assert status.api_key_configured is False
    assert status.compatibility_mode == "relaxed"
    assert (await gateway.disable()).mode == "demo"
    await gateway.close()


async def test_existing_runtime_key_can_be_reused_for_same_endpoint(tmp_path: Path) -> None:
    gateway = make_gateway(tmp_path)
    await gateway.configure(
        ModelConfigRequest(
            provider="qwen",
            model_name="qwen-plus",
            api_key="dashscope-secret",
        )
    )

    status = await gateway.configure(ModelConfigRequest(provider="qwen", model_name="qwen-max"))

    assert status.model_name == "qwen-max"
    assert status.api_key_configured is True
    await gateway.close()


def test_model_config_rejects_credentials_in_base_url() -> None:
    with pytest.raises(ValidationError, match="must not contain credentials"):
        ModelConfigRequest(
            provider="custom",
            model_name="local-model",
            base_url="http://user:password@localhost:8000/v1",
            no_api_key=True,
        )


async def test_provider_requiring_key_rejects_missing_key(tmp_path: Path) -> None:
    gateway = make_gateway(tmp_path)

    with pytest.raises(ModelConfigurationError, match="api_key is required"):
        await gateway.configure(ModelConfigRequest(provider="deepseek", model_name="deepseek-chat"))


async def test_persisted_config_restored_after_restart(tmp_path: Path) -> None:
    settings = Settings(
        mode="demo",
        data_file=tmp_path / "cases.json",
        model_config_file=tmp_path / "model-config.json",
        allowed_roots=[tmp_path],
    )
    gateway = ModelGateway(settings)
    await gateway.configure(
        ModelConfigRequest(provider="deepseek", model_name="deepseek-chat", api_key="sk-persist-me")
    )
    await gateway.close()

    # 模拟进程重启：新 Gateway 实例应自动恢复上次配置
    restarted = ModelGateway(settings)
    status = restarted.status()
    assert status.mode == "model"
    assert status.provider == "deepseek"
    assert status.model_name == "deepseek-chat"
    assert status.api_key_configured is True
    assert status.source == "persisted"
    assert "sk-persist-me" not in status.model_dump_json()
    # 配置文件仅本进程可读写
    mode_bits = (tmp_path / "model-config.json").stat().st_mode & 0o777
    assert mode_bits == 0o600
    await restarted.close()


async def test_disable_removes_persisted_config(tmp_path: Path) -> None:
    settings = Settings(
        mode="demo",
        data_file=tmp_path / "cases.json",
        model_config_file=tmp_path / "model-config.json",
        allowed_roots=[tmp_path],
    )
    gateway = ModelGateway(settings)
    await gateway.configure(
        ModelConfigRequest(provider="deepseek", model_name="deepseek-chat", api_key="sk-to-remove")
    )
    assert (tmp_path / "model-config.json").exists()

    status = await gateway.disable()

    assert status.configured is False
    assert not (tmp_path / "model-config.json").exists()
    restarted = ModelGateway(settings)
    assert restarted.status().configured is False
    await gateway.close()
    await restarted.close()


async def test_environment_config_takes_precedence_over_persisted(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("HARMONY_AGENT_MODE", "model")
    monkeypatch.setenv("HARMONY_AGENT_MODEL", "openai:gpt-5-mini")
    settings = Settings(
        data_file=tmp_path / "cases.json",
        model_config_file=tmp_path / "model-config.json",
        allowed_roots=[tmp_path],
    )
    gateway = ModelGateway(settings)
    await gateway.configure(
        ModelConfigRequest(provider="deepseek", model_name="deepseek-chat", api_key="sk-persisted")
    )
    await gateway.close()

    restarted = ModelGateway(settings)
    status = restarted.status()
    assert status.source == "environment"
    assert status.provider == "openai"
    await restarted.close()


async def test_get_model_for_overrides_within_same_provider(tmp_path: Path) -> None:
    gateway = make_gateway(tmp_path)
    await gateway.configure(
        ModelConfigRequest(provider="deepseek", model_name="deepseek-chat", api_key="sk-x")
    )

    # 纯模型名：沿用当前供应商
    model = await gateway.get_model_for("deepseek-reasoner")
    assert isinstance(model, OpenAIChatModel)
    assert model.model_name == "deepseek-reasoner"

    # provider:model 形式
    model = await gateway.get_model_for("deepseek:deepseek-v4-pro")
    assert isinstance(model, OpenAIChatModel)
    assert model.model_name == "deepseek-v4-pro"

    # 跨供应商覆盖不支持：回退全局配置
    fallback = await gateway.get_model_for("openai:gpt-5.2")
    assert isinstance(fallback, OpenAIChatModel)
    assert fallback.model_name == "deepseek-chat"

    # 空覆盖 = 全局配置
    assert await gateway.get_model_for(None) is not None
    await gateway.close()


async def test_get_model_for_without_config_returns_none(tmp_path: Path) -> None:
    gateway = make_gateway(tmp_path)
    assert await gateway.get_model_for("deepseek-chat") is None
    await gateway.close()
