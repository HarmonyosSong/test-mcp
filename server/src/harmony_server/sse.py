from __future__ import annotations

import json

from ag_ui.core import EventType
from harmony_agent.domain import utc_now


def sse_event(event_type: EventType, run_id: str, **payload: object) -> str:
    body = {
        "type": event_type.value,
        "run_id": run_id,
        "timestamp": utc_now().isoformat(),
        **{key: _json_value(value) for key, value in payload.items()},
    }
    return f"event: {event_type.value}\ndata: {json.dumps(body, ensure_ascii=False)}\n\n"


def _json_value(value: object) -> object:
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return model_dump(mode="json")
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    return value
