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
    turn can cite evidence observed earlier.

    淘汰分两层(替代 ADR 0002 的单纯 120 条 FIFO):
    - 历史容量 max_entries 是软目标:超额时淘汰最旧的**非本轮**观测;
    - 本轮观测受保护不被淘汰,但受 max_current_turn / max_current_turn_bytes 硬上限约束,
      达到即拒绝接纳(admission 失败不产出可引用 ID)。
    被淘汰的观测留墓碑(id → 原位置),把「过期」与「从未观测」区分开。
    """

    entries: dict[str, Evidence] = field(default_factory=dict)
    texts: dict[str, str] = field(default_factory=dict)
    input_texts: list[str] = field(default_factory=list)
    max_entries: int = 300
    max_current_turn: int = 1000
    max_current_turn_bytes: int = 4 * 1024 * 1024
    _current_turn_ids: set[str] = field(default_factory=set)
    _current_turn_bytes: int = 0
    _evicted: dict[str, str] = field(default_factory=dict)
    restored_count: int = 0

    def add(self, evidence: Evidence, text: str | None = None) -> bool:
        """登记观测;返回 False 表示达到当前轮硬上限、拒绝接纳(不得引用该 ID)。"""
        body = text if text is not None else evidence.excerpt
        incoming = len(body.encode("utf-8"))
        is_new = evidence.id not in self.entries
        if is_new and (
            len(self._current_turn_ids) >= self.max_current_turn
            or self._current_turn_bytes + incoming > self.max_current_turn_bytes
        ):
            return False
        self.entries[evidence.id] = evidence
        self.texts[evidence.id] = body
        if evidence.id in self._evicted:
            # ID 是内容哈希:重读同内容得到同 ID,被淘汰的观测天然可恢复。
            del self._evicted[evidence.id]
            self.restored_count += 1
        if is_new:
            self._current_turn_ids.add(evidence.id)
            self._current_turn_bytes += incoming
        while len(self.entries) > self.max_entries:
            evictable = next(
                (key for key in self.entries if key not in self._current_turn_ids), None
            )
            if evictable is None:
                break  # 其余全是本轮保护观测,交由硬上限约束
            self._evicted[evictable] = self.entries[evictable].location or "unknown"
            del self.entries[evictable]
            self.texts.pop(evictable, None)
        while len(self._evicted) > 500:
            self._evicted.pop(next(iter(self._evicted)))
        return True

    def snapshot(self) -> dict:
        return {
            "entries": [item.model_dump(mode="json") for item in self.entries.values()],
            "texts": self.texts,
            # 墓碑跨轮保留:下一轮引用被淘汰的 ID 仍能区分「过期」与「从未观测」。
            "evicted": dict(self._evicted),
            # 容量配置随快照走:restore 不能把定制容量静默退回默认值。
            "max_entries": self.max_entries,
            "max_current_turn": self.max_current_turn,
            "max_current_turn_bytes": self.max_current_turn_bytes,
            "ledger_version": 2,
        }

    @classmethod
    def restore(cls, state: dict | None, input_texts: list[str]) -> EvidenceLedger:
        state = state or {}
        ledger = cls(
            input_texts=input_texts,
            max_entries=state.get("max_entries", 300),
            max_current_turn=state.get("max_current_turn", 1000),
            max_current_turn_bytes=state.get("max_current_turn_bytes", 4 * 1024 * 1024),
        )
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
            # entries/texts 必须配对:缺 text 的用 excerpt 补齐,不能绕过校验读入孤儿条目。
            for evidence in ledger.entries.values():
                ledger.texts.setdefault(evidence.id, evidence.excerpt)
            evicted = state.get("evicted")
            if isinstance(evicted, dict):
                ledger._evicted = {
                    str(key): str(value)
                    for key, value in evicted.items()
                    if key not in ledger.entries
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
        capacity_reached = False
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
            # admission 先于登记:容量满时该行不产出 ID,绝不返回无法引用的引用。
            if not self.add(evidence, text):
                capacity_reached = True
                break
            references.append(evidence.model_dump(mode="json", exclude={"excerpt", "supports"}))
        # Return provenance once, without duplicating the source text in each evidence record.
        if capacity_reached:
            return {
                "evidence_refs": references,
                "result": result,
                "observation_capacity_reached": True,
                "limitation": "本轮观测容量已达上限;未接纳的行没有可引用 ID。请用已有观测收尾。",
            }
        return {"evidence_refs": references, "result": result}

    def validate(self, report: DiagnosisReport) -> DiagnosisReport:
        for evidence in report.evidence:
            if evidence.kind is EvidenceKind.USER:
                # 用户证据不进观测账本(提交时才有 ID),核的是内容:摘录必须是用户
                # 真实说过的原话,防止编造"用户没说过的话"来撑现象。
                if not evidence.excerpt.strip() or not any(
                    evidence.excerpt in text for text in self.input_texts
                ):
                    raise ModelRetry(
                        f"Evidence {evidence.id} cites the user, but the excerpt does not "
                        "appear in any user message. Quote the user's words verbatim."
                    )
                continue
            observed = self.entries.get(evidence.id)
            if observed is None:
                # 细分「过期」与「从未观测」:过期给原观测位置,重读同内容即可
                # 恢复同一 ID(内容哈希);未知 ID 附可用清单,让模型直接照抄。
                if evidence.id in self._evicted:
                    raise ModelRetry(
                        f"Evidence {evidence.id} expired: evicted from ledger; originally "
                        f"observed at {self._evicted[evidence.id]}. Re-read that exact "
                        "location; identical content restores the same ID."
                    )
                listing = ", ".join(
                    f"{eid}({item.location})" for eid, item in list(self.entries.items())[-20:]
                )
                raise ModelRetry(
                    f"Evidence {evidence.id} unknown: no such observation. "
                    f"Observed evidence IDs (latest 20): {listing or 'none'}. "
                    "Copy an ID from this list, or make a new observation."
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
                # USER 证据不在观测账本:只能登记现象,不计入正向候选支撑。
                # 必须用 entries.get——直接索引会对 USER ID 裸抛 KeyError。
                if not any(
                    (obs := self.entries.get(eid)) is not None
                    and obs.kind in {EvidenceKind.SOURCE, EvidenceKind.LOG}
                    for eid in candidate.evidence_ids
                ):
                    raise ModelRetry("A positive candidate needs observed source or log evidence.")
        return report
