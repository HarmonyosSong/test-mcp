from __future__ import annotations

from dataclasses import dataclass

from ..domain import DiagnosisCase, Evidence


@dataclass(slots=True)
class DiagnosisDependencies:
    case: DiagnosisCase
    evidence: list[Evidence]
    workspace_checks: list[str]
