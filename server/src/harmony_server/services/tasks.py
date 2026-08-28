from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any

from fastapi import FastAPI


def schedule_task(app: FastAPI, coroutine: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
    task = asyncio.create_task(coroutine)
    app.state.tasks.add(task)
    task.add_done_callback(app.state.tasks.discard)
    return task
