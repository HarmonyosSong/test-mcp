from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from harmony_agent.domain import (
    AvailableModelsRequest,
    ModelConfigRequest,
    ModelConnectionResult,
    ModelProviderPreset,
    ModelStatus,
)
from harmony_agent.runtimes.model_gateway import (
    ModelConfigurationError,
    ModelConnectionError,
)

from ..dependencies import ApplicationContainer

router = APIRouter(prefix="/api/model", tags=["models"])


def container(request: Request) -> ApplicationContainer:
    return request.app.state.container


@router.get("/providers", response_model=list[ModelProviderPreset])
async def model_providers(request: Request) -> list[ModelProviderPreset]:
    return container(request).model_gateway.providers()


@router.get("/status", response_model=ModelStatus)
async def model_status(request: Request) -> ModelStatus:
    return container(request).model_gateway.status()


@router.put("/config", response_model=ModelStatus)
async def configure_model(payload: ModelConfigRequest, request: Request) -> ModelStatus:
    try:
        return await container(request).model_gateway.configure(payload)
    except ModelConfigurationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/test", response_model=ModelConnectionResult)
async def test_model(
    payload: ModelConfigRequest,
    request: Request,
) -> ModelConnectionResult:
    try:
        return await container(request).model_gateway.test_connection(payload)
    except ModelConfigurationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ModelConnectionError as exc:
        raise HTTPException(status_code=502, detail=f"模型连接失败：{exc}") from exc


@router.get("/available-models", response_model=list[str])
async def available_models(request: Request) -> list[str]:
    """用当前生效的模型配置拉取可用模型列表。"""
    try:
        return await container(request).model_gateway.list_configured_models()
    except ModelConfigurationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ModelConnectionError as exc:
        raise HTTPException(status_code=502, detail=f"模型列表获取失败：{exc}") from exc


@router.post("/available-models", response_model=list[str])
async def probe_available_models(payload: AvailableModelsRequest, request: Request) -> list[str]:
    """用表单中的（可能尚未保存的）凭据拉取模型列表，供设置弹窗补全。"""
    api_key = (
        payload.api_key.get_secret_value().strip()
        if payload.api_key and not payload.no_api_key
        else None
    )
    try:
        return await container(request).model_gateway.list_available_models(
            payload.provider, payload.base_url, api_key or None
        )
    except ModelConfigurationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ModelConnectionError as exc:
        raise HTTPException(status_code=502, detail=f"模型列表获取失败：{exc}") from exc


@router.delete("/config", response_model=ModelStatus)
async def disable_model(request: Request) -> ModelStatus:
    return await container(request).model_gateway.disable()
