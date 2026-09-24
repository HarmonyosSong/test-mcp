from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.exceptions import ModelRetry

from ..domain import DiagnosisReport, Evidence, EvidenceKind, Verdict


@dataclass
class EvidenceLedger:
    """Conversation-scoped observations from input and repository tools, never model claims.

    Persists across turns (serialized on the conversation) so a report submitted in a later
    turn can cite evidence observed earlier. Capped; oldest entries evict first.
    """

    entries: dict[str, Evidence] = field(default_factory=dict)
    texts: dict[str, str] = field(default_factory=dict)
    input_texts: list[str] = field(default_factory=list)
    max_entries: int = 120

    def add(self, evidence: Evidence, text: str | None = None) -> None:
        self.entries[evidence.id] = evidence
        self.texts[evidence.id] = text if text is not None else evidence.excerpt
        while len(self.entries) > self.max_entries:
            oldest = next(iter(self.entries))
            del self.entries[oldest]
            self.texts.pop(oldest, None)

    def snapshot(self) -> dict:
        return {
            "entries": [item.model_dump(mode="json") for item in self.entries.values()],
            "texts": self.texts,
        }

    @classmethod
    def restore(cls, state: dict | None, input_texts: list[str]) -> EvidenceLedger:
        ledger = cls(input_texts=input_texts)
        if state:
            for raw in state.get("entries", []):
                try:
                    evidence = Evidence.model_validate(raw)
                except ValueError:
                    continue
                ledger.entries[evidence.id] = evidence
            ledger.texts = {
                key: value
                for key, value in state.get("texts", {}).items()
                if key in ledger.entries and isinstance(value, str)
            }
        return ledger

    def capture(self, name: str, arguments: dict, result: Any) -> Any:
        if name not in {"read_project_file", "search_project_text", "parse_hilog"}:
            return result
        if name == "parse_hilog" and not any(
            arguments.get("log_text") and arguments["log_text"] in text for text in self.input_texts
        ):
            return {
                "evidence_refs": [],
                "result": result,
                "limitation": "解析输入未对应已提供的日志，不能作为本次故障的观测证据。",
            }
        if name == "parse_hilog" and isinstance(result, dict):
            rows = result.get("error_lines", [])
        else:
            rows = result if isinstance(result, list) else [result]
        references: list[dict] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            text = row.get("content", row.get("excerpt", ""))
            if not isinstance(text, str) or not text.strip():
                continue
            path = row.get("path", "pasted-hilog")
            line = row.get("line", row.get("start_line", 1))
            location = f"{path}:{line}"
            digest = hashlib.sha256(
                json.dumps([name, arguments, location, text], sort_keys=True).encode()
            ).hexdigest()[:16]
            evidence = Evidence(
                id=f"ev-{digest}",
                kind=EvidenceKind.LOG if name == "parse_hilog" else EvidenceKind.SOURCE,
                source=f"mcp:{name}",
                location=location,
                excerpt=text[:2000],
                supports="工具实际返回的观测；是否支持因果关系仍需判断",
            )
            self.add(evidence, text)
            references.append(evidence.model_dump(mode="json", exclude={"excerpt", "supports"}))
        # Return provenance once, without duplicating the source text in each evidence record.
        return {"evidence_refs": references, "result": result}

    def validate(self, report: DiagnosisReport) -> DiagnosisReport:
        for evidence in report.evidence:
            observed = self.entries.get(evidence.id)
            if observed is None:
                raise ModelRetry(
                    f"Evidence {evidence.id} was not observed. Use runtime evidence IDs."
                )
            if any(
                getattr(evidence, key) != getattr(observed, key)
                for key in ("kind", "source", "location")
            ):
                raise ModelRetry(f"Evidence {evidence.id} provenance differs from the observation.")
            if not evidence.excerpt.strip() or evidence.excerpt not in self.texts[evidence.id]:
                raise ModelRetry(f"Evidence {evidence.id} must quote an exact observed excerpt.")
        if report.verdict in {Verdict.LOCATED, Verdict.PROBABLE}:
            for candidate in report.root_cause_candidates:
                if not any(
                    self.entries[eid].kind in {EvidenceKind.SOURCE, EvidenceKind.LOG}
                    for eid in candidate.evidence_ids
                ):
                    raise ModelRetry("A positive candidate needs observed source or log evidence.")
        return report
