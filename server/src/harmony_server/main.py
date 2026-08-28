from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from harmony_agent.config import Settings, get_settings
from harmony_agent.domain import (
    MODEL_CONTEXT_WINDOWS,
    MODEL_PRICES,
    MetaResponse,
    ModelStatus,
)
from harmony_repo_mcp import MCP_TOOL_NAMES

from .agui import router as agui_router
from .chat_stream import router as chat_stream_router
from .dependencies import build_container
from .routes import cases_router, conversations_router, models_router, repositories_router


def create_app(settings: Settings | None = None, static_dir: Path | str | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    container = build_container(resolved_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await container.cases.initialize()
        await container.conversations.initialize()
        await container.repositories.initialize()
        app.state.tasks = set()
        yield
        tasks = list(app.state.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await container.model_gateway.close()

    app = FastAPI(
        title="Harmony Agent Server",
        version="0.1.0",
        description="AG-UI and REST gateway for read-only HarmonyOS diagnosis",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )
    app.state.container = container

    @app.exception_handler(RequestValidationError)
    async def redact_validation_error(
        _request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        errors = exc.errors()
        for error in errors:
            if "input" in error:
                error["input"] = _redact_secrets(error["input"])
        return JSONResponse(status_code=422, content=jsonable_encoder({"detail": errors}))

    @app.get("/api/health")
    async def health() -> dict[str, str | None]:
        model_status: ModelStatus = container.model_gateway.status()
        return {
            "status": "ok",
            "mode": model_status.mode,
            "model": model_status.model_name,
            "provider": model_status.provider_name,
        }

    @app.get("/api/meta", response_model=MetaResponse)
    async def meta() -> MetaResponse:
        model_status: ModelStatus = container.model_gateway.status()
        return MetaResponse(
            mode=model_status.mode,
            model=model_status.model_name,
            skills=container.skills.summaries(),
            mcp_tools=MCP_TOOL_NAMES,
            constraints=["read-only", "no-shell", "no-code-changes", "no-deveco-cli"],
            context_windows=MODEL_CONTEXT_WINDOWS,
            model_prices=MODEL_PRICES,
        )

    app.include_router(agui_router)
    app.include_router(cases_router)
    app.include_router(conversations_router)
    app.include_router(chat_stream_router)
    app.include_router(models_router)
    app.include_router(repositories_router)

    if static_dir is not None:
        static_path = Path(static_dir)
        if static_path.is_dir():
            app.mount("/", StaticFiles(directory=static_path, html=True), name="static")
    return app


def _redact_secrets(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: "**********"
            if isinstance(key, str) and key.casefold() in {"api_key", "authorization"}
            else _redact_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_secrets(item) for item in value]
    return value


def run() -> None:
    parser = argparse.ArgumentParser(description="Harmony Agent Server")
    parser.add_argument("--host", type=str, default=os.environ.get("HARMONY_AGENT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("HARMONY_AGENT_PORT", "8000")))
    parser.add_argument(
        "--static-dir",
        type=str,
        default=os.environ.get("HARMONY_AGENT_STATIC_DIR", "web/dist"),
        help="前端静态文件目录，相对工作目录或绝对路径；不存在则不挂载",
    )
    args = parser.parse_args()

    static_dir: Path | None = None
    if args.static_dir:
        candidate = Path(args.static_dir)
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        static_dir = candidate if candidate.is_dir() else None

    app = create_app(static_dir=static_dir)
    uvicorn.run(app, host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    run()
