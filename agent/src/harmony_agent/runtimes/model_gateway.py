from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field, replace
from time import perf_counter

from openai import AsyncOpenAI
from pydantic_ai import Agent, InlineDefsJsonSchemaTransformer
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.profiles.openai import OpenAIModelProfile
from pydantic_ai.providers.openai import OpenAIProvider

from ..config import Settings
from ..domain import (
    ModelConfigRequest,
    ModelConnectionResult,
    ModelProviderPreset,
    ModelStatus,
)

PROVIDER_PRESETS: tuple[ModelProviderPreset, ...] = (
    ModelProviderPreset(
        id="openai",
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        default_model="gpt-5.2",
        suggested_models=["gpt-5.2", "gpt-5-mini"],
        api_key_env="OPENAI_API_KEY",
    ),
    ModelProviderPreset(
        id="deepseek",
        name="DeepSeek",
        base_url="https://api.deepseek.com",
        default_model="deepseek-v4-pro",
        suggested_models=["deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
        api_key_env="DEEPSEEK_API_KEY",
    ),
    ModelProviderPreset(
        id="qwen",
        name="通义千问（DashScope）",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model="qwen-plus",
        suggested_models=["qwen-plus", "qwen-max", "qwen-turbo"],
        api_key_env="DASHSCOPE_API_KEY",
        note="企业 Workspace 可将 Base URL 替换为对应地域的 maas.aliyuncs.com 地址。",
    ),
    ModelProviderPreset(
        id="moonshot",
        name="Moonshot / Kimi",
        base_url="https://api.moonshot.cn/v1",
        default_model="kimi-k3",
        suggested_models=["kimi-k3", "moonshot-v1-8k", "moonshot-v1-32k"],
        api_key_env="MOONSHOT_API_KEY",
    ),
    ModelProviderPreset(
        id="zhipu",
        name="智谱 GLM",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        default_model="glm-5.3",
        suggested_models=["glm-5.3", "glm-4-flash", "glm-4-plus"],
        api_key_env="ZHIPUAI_API_KEY",
    ),
    ModelProviderPreset(
        id="doubao",
        name="火山方舟 / 豆包",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        default_model="doubao-seed-2-1-pro-260628",
        suggested_models=["doubao-seed-2-1-pro-260628"],
        api_key_env="ARK_API_KEY",
        note="模型字段兼容当前 Model ID、历史 ep-* 接入点和私有部署标识。",
    ),
    ModelProviderPreset(
        id="custom",
        name="自定义 OpenAI 兼容接口",
        base_url="",
        default_model="",
        suggested_models=[],
        requires_api_key=False,
    ),
)
PRESETS_BY_ID = {preset.id: preset for preset in PROVIDER_PRESETS}


class ModelConfigurationError(ValueError):
    pass


class ModelConnectionError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ActiveModelConfig:
    provider: str
    provider_name: str
    model_name: str
    base_url: str | None
    api_key: str | None = field(repr=False)
    source: str = "runtime"
    model: Model | str | None = field(default=None, repr=False)
    compatibility_mode: str = "standard"


class ModelGateway:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = asyncio.Lock()
        self._clients: list[AsyncOpenAI] = []
        # 优先级：环境变量 > 持久化配置。两者都没有则处于 demo 模式。
        self._active: ActiveModelConfig | None = self._from_environment(
            settings
        ) or self._load_persisted(settings)

    @property
    def enabled(self) -> bool:
        return self._active is not None

    def providers(self) -> list[ModelProviderPreset]:
        return [preset.model_copy(deep=True) for preset in PROVIDER_PRESETS]

    def status(self) -> ModelStatus:
        active = self._active
        if active is None:
            return ModelStatus(mode="demo", configured=False)
        return ModelStatus(
            mode="model",
            configured=True,
            provider=active.provider,
            provider_name=active.provider_name,
            model_name=active.model_name,
            base_url=active.base_url,
            api_key_configured=bool(active.api_key),
            source=active.source,
            compatibility_mode=active.compatibility_mode,
        )

    async def configure(self, request: ModelConfigRequest) -> ModelStatus:
        async with self._lock:
            resolved = self._resolve_request(request)
            model, client = self._build_compatible_model(resolved, timeout_seconds=120.0)
            self._clients.append(client)
            self._active = ActiveModelConfig(
                provider=resolved.provider,
                provider_name=resolved.provider_name,
                model_name=resolved.model_name,
                base_url=resolved.base_url,
                api_key=resolved.api_key,
                model=model,
                compatibility_mode=resolved.compatibility_mode,
            )
            self._persist(resolved)
            return self.status()

    async def disable(self) -> ModelStatus:
        async with self._lock:
            self._active = None
            self._discard_persisted()
            return self.status()

    async def get_model(self) -> Model | str | None:
        async with self._lock:
            return self._active.model if self._active else None

    async def get_model_for(self, spec: str | None) -> Model | str | None:
        """解析会话级模型覆盖。支持 "provider:model" 或纯模型名（沿用当前供应商）。

        跨供应商覆盖暂不支持（凭据隔离），供应商不匹配时返回 None，
        调用方应回退到全局配置。
        """
        if not spec:
            return await self.get_model()
        async with self._lock:
            active = self._active
            if active is None:
                return None
            provider, separator, model_name = spec.partition(":")
            if not separator:
                provider, model_name = active.provider, spec
            if provider != active.provider or not model_name:
                return active.model
            config = replace(active, model_name=model_name)
            model, client = self._build_compatible_model(config, timeout_seconds=120.0)
            self._clients.append(client)
            return model

    async def list_configured_models(self) -> list[str]:
        """用当前生效配置拉取模型列表（聊天页模型选择器用，前端不接触 API Key）。"""
        active = self._active
        if active is None:
            raise ModelConfigurationError("model is not configured")
        return await self.list_available_models(active.provider, active.base_url, active.api_key)

    async def list_available_models(
        self,
        provider: str,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> list[str]:
        """调用 OpenAI 兼容的 GET /models 拉取可用模型列表。

        凭据优先级：传入的 api_key > 当前生效配置（同供应商且同 base_url）> 环境变量。
        """
        preset = PRESETS_BY_ID.get(provider)
        if preset is None:
            raise ModelConfigurationError("unsupported model provider")
        resolved_base_url = base_url or preset.base_url
        if not resolved_base_url:
            raise ModelConfigurationError("base_url is required for the custom provider")
        resolved_key = api_key
        active = self._active
        if (
            not resolved_key
            and active
            and active.provider == provider
            and active.base_url == resolved_base_url
        ):
            resolved_key = active.api_key
        if not resolved_key and preset.api_key_env:
            resolved_key = os.getenv(preset.api_key_env)
        client = AsyncOpenAI(
            api_key=resolved_key or "not-required",
            base_url=resolved_base_url,
            timeout=15.0,
            max_retries=0,
        )
        try:
            page = await client.models.list()
            return sorted({item.id for item in page.data})
        except Exception as exc:
            message = self._redact(str(exc), resolved_key)
            raise ModelConnectionError(message or type(exc).__name__) from exc
        finally:
            await client.close()

    async def test_connection(self, request: ModelConfigRequest) -> ModelConnectionResult:
        async with self._lock:
            resolved = self._resolve_request(request)
        model, client = self._build_compatible_model(resolved, timeout_seconds=20.0)
        started = perf_counter()
        try:
            agent = Agent(
                model,
                output_type=str,
                instructions="This is a connection check. Return a short plain-text response.",
            )
            result = await agent.run("Reply with exactly: OK")
        except Exception as exc:
            message = self._redact(str(exc), resolved.api_key)
            raise ModelConnectionError(message or type(exc).__name__) from exc
        finally:
            await client.close()
        latency_ms = max(1, round((perf_counter() - started) * 1_000))
        return ModelConnectionResult(
            ok=True,
            provider=resolved.provider,
            model_name=resolved.model_name,
            latency_ms=latency_ms,
            response_preview=str(result.output).strip()[:120],
        )

    async def close(self) -> None:
        clients, self._clients = self._clients, []
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)

    def _resolve_request(self, request: ModelConfigRequest) -> ActiveModelConfig:
        preset = PRESETS_BY_ID.get(request.provider)
        if preset is None:
            raise ModelConfigurationError("unsupported model provider")
        base_url = request.base_url or preset.base_url
        if not base_url:
            raise ModelConfigurationError("base_url is required for the custom provider")
        api_key = None if request.no_api_key else self._request_api_key(request, preset, base_url)
        if preset.requires_api_key and not api_key:
            raise ModelConfigurationError("api_key is required for this provider")
        return ActiveModelConfig(
            provider=preset.id,
            provider_name=preset.name,
            model_name=request.model_name,
            base_url=base_url,
            api_key=api_key,
            compatibility_mode=request.compatibility_mode,
        )

    def _request_api_key(
        self,
        request: ModelConfigRequest,
        preset: ModelProviderPreset,
        base_url: str,
    ) -> str | None:
        if request.api_key:
            value = request.api_key.get_secret_value().strip()
            if value:
                return value
        active = self._active
        if (
            active
            and active.source in {"runtime", "persisted"}
            and active.provider == request.provider
            and active.base_url == base_url
        ):
            return active.api_key
        return os.getenv(preset.api_key_env) if preset.api_key_env else None

    def _persist(self, config: ActiveModelConfig) -> None:
        """把运行时配置落盘（含 API Key），仅限本机后端进程读写。"""
        path = self.settings.model_config_file
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "provider": config.provider,
            "model_name": config.model_name,
            "base_url": config.base_url,
            "api_key": config.api_key,
            "compatibility_mode": config.compatibility_mode,
        }
        temporary = path.with_suffix(f"{path.suffix}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(path)

    def _discard_persisted(self) -> None:
        self.settings.model_config_file.unlink(missing_ok=True)

    def _load_persisted(self, settings: Settings) -> ActiveModelConfig | None:
        path = settings.model_config_file
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        preset = PRESETS_BY_ID.get(raw.get("provider", ""))
        if preset is None or not raw.get("model_name"):
            return None
        config = ActiveModelConfig(
            provider=preset.id,
            provider_name=preset.name,
            model_name=raw["model_name"],
            base_url=raw.get("base_url") or preset.base_url or None,
            api_key=raw.get("api_key") or None,
            source="persisted",
            compatibility_mode=raw.get("compatibility_mode") or "standard",
        )
        model, client = self._build_compatible_model(config, timeout_seconds=120.0)
        self._clients.append(client)
        return ActiveModelConfig(
            provider=config.provider,
            provider_name=config.provider_name,
            model_name=config.model_name,
            base_url=config.base_url,
            api_key=config.api_key,
            source="persisted",
            model=model,
            compatibility_mode=config.compatibility_mode,
        )

    @staticmethod
    def _build_compatible_model(
        config: ActiveModelConfig,
        *,
        timeout_seconds: float,
    ) -> tuple[OpenAIChatModel, AsyncOpenAI]:
        client = AsyncOpenAI(
            api_key=config.api_key or "not-required",
            base_url=config.base_url,
            timeout=timeout_seconds,
            max_retries=0,
        )
        profile = None
        if config.compatibility_mode == "relaxed":
            profile = OpenAIModelProfile(
                json_schema_transformer=InlineDefsJsonSchemaTransformer,
                openai_supports_strict_tool_definition=False,
                openai_chat_supports_multiple_system_messages=False,
                openai_chat_supports_max_completion_tokens=False,
            )
        model = OpenAIChatModel(
            config.model_name,
            provider=OpenAIProvider(openai_client=client),
            profile=profile,
        )
        return model, client

    @staticmethod
    def _from_environment(settings: Settings) -> ActiveModelConfig | None:
        if not settings.model_enabled:
            return None
        provider, separator, model_name = settings.model.partition(":")
        if not separator:
            provider, model_name = "configured", settings.model
        preset = PRESETS_BY_ID.get(provider)
        env_key = os.getenv(preset.api_key_env) if preset and preset.api_key_env else None
        return ActiveModelConfig(
            provider=provider,
            provider_name=preset.name if preset else provider,
            model_name=model_name,
            base_url=preset.base_url if preset else None,
            api_key=env_key,
            source="environment",
            model=settings.model,
            compatibility_mode="standard",
        )

    @staticmethod
    def _redact(message: str, api_key: str | None) -> str:
        if api_key:
            return message.replace(api_key, "***")
        return message
