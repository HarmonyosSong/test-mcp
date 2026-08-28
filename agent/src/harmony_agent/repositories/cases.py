from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ..domain import DiagnosisCase, utc_now


class CaseNotFoundError(KeyError):
    pass


class CaseRepository:
    def __init__(self, data_file: Path) -> None:
        self.data_file = data_file
        self._cases: dict[str, DiagnosisCase] = {}
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        async with self._lock:
            if not self.data_file.exists():
                return
            raw = await asyncio.to_thread(self.data_file.read_text, encoding="utf-8")
            if not raw.strip():
                return
            values = json.loads(raw)
            self._cases = {item["id"]: DiagnosisCase.model_validate(item) for item in values}

    async def list(self) -> list[DiagnosisCase]:
        async with self._lock:
            cases = sorted(self._cases.values(), key=lambda item: item.updated_at, reverse=True)
            return [case.model_copy(deep=True) for case in cases]

    async def get(self, case_id: str) -> DiagnosisCase:
        async with self._lock:
            try:
                return self._cases[case_id].model_copy(deep=True)
            except KeyError as exc:
                raise CaseNotFoundError(case_id) from exc

    async def save(self, case: DiagnosisCase) -> DiagnosisCase:
        async with self._lock:
            case.updated_at = utc_now()
            self._cases[case.id] = case.model_copy(deep=True)
            await self._persist_locked()
            return case.model_copy(deep=True)

    async def _persist_locked(self) -> None:
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            [case.model_dump(mode="json") for case in self._cases.values()],
            ensure_ascii=False,
            indent=2,
        )
        temporary = self.data_file.with_suffix(f"{self.data_file.suffix}.tmp")
        await asyncio.to_thread(temporary.write_text, payload, encoding="utf-8")
        await asyncio.to_thread(temporary.replace, self.data_file)
