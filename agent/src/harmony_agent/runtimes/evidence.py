from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.exceptions import ModelRetry

from ..domain import DiagnosisReport, DiagnosisReportDraft, Evidence, EvidenceKind, Verdict


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
    # 用户输入引用:id → 原文。不进观测账本;每轮由 register_user_texts 从
    # input_texts 确定性重建(内容哈希 ID 跨轮稳定),无需持久化。
    user_refs: dict[str, str] = field(default_factory=dict)

    def register_user_texts(self) -> list[dict[str, str]]:
        """把用户输入登记为可引用证据,返回有界清单(id + 预览)供注入 instructions。"""
        refs: list[dict[str, str]] = []
        for text in self.input_texts:
            digest = hashlib.sha256(text.encode()).hexdigest()[:12]
            uid = f"ev-user-{digest}"
            self.user_refs.setdefault(uid, text)
            refs.append({"id": uid, "preview": text[:40]})
        return refs

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

    def resolve_draft(self, draft: DiagnosisReportDraft) -> DiagnosisReport:
        """把引用式草稿解析为完整报告:逐条核对摘录,出处字段由账本组装。

        错误码(模型可据此行动):
        - unknown_evidence_id:ID 从未被观测(附可用清单)
        - evidence_expired:ID 曾被观测但已淘汰(附原位置;重读同内容恢复同 ID)
        - excerpt_mismatch:摘录不是观测原文/用户消息的逐字子串
        - positive_without_observed_source:正向候选缺源码/日志观测
        """
        resolved: list[Evidence] = []
        for citation in draft.evidence:
            user_text = self.user_refs.get(citation.id)
            if user_text is not None:
                if citation.excerpt.strip() not in user_text:
                    raise ModelRetry(
                        f"excerpt_mismatch: {citation.id} 是用户输入引用,"
                        "摘录必须逐字摘自该条用户消息。"
                    )
                resolved.append(
                    Evidence(
                        id=citation.id,
                        kind=EvidenceKind.USER,
                        source="user-message",
                        location=user_text[:30] + ("…" if len(user_text) > 30 else ""),
                        excerpt=citation.excerpt,
                        supports=citation.supports,
                    )
                )
                continue
            observed = self.entries.get(citation.id)
            if observed is None:
                if citation.id in self._evicted:
                    raise ModelRetry(
                        f"evidence_expired: {citation.id} 的观测已被淘汰;原位置 "
                        f"{self._evicted[citation.id]},重读该位置同内容可恢复同一 ID。"
                    )
                listing = ", ".join(
                    f"{eid}({item.location})" for eid, item in list(self.entries.items())[-20:]
                )
                raise ModelRetry(
                    f"unknown_evidence_id: {citation.id} 从未被观测。"
                    f"可用 ID(最近 20):{listing or '无'}。请照抄清单 ID 或重新观测。"
                )
            if citation.excerpt.strip() not in self.texts[citation.id]:
                raise ModelRetry(
                    f"excerpt_mismatch: {citation.id} 的摘录必须是观测原文的逐字子串。"
                )
            resolved.append(
                Evidence(
                    id=observed.id,
                    kind=observed.kind,
                    source=observed.source,
                    location=observed.location,
                    excerpt=citation.excerpt,
                    supports=citation.supports,
                )
            )
        report = DiagnosisReport(
            verdict=draft.verdict,
            severity=draft.severity,
            summary=draft.summary,
            issue_category=draft.issue_category,
            likely_location=draft.likely_location,
            root_cause_candidates=draft.root_cause_candidates,
            evidence=resolved,
            ruled_out=draft.ruled_out,
            missing_information=draft.missing_information,
            checks_performed=draft.checks_performed,
            limitations=draft.limitations,
            confidence=draft.confidence,
        )
        if report.verdict in {Verdict.LOCATED, Verdict.PROBABLE}:
            resolved_by_id = {item.id: item for item in resolved}
            for candidate in report.root_cause_candidates:
                # 用户引用只支撑现象存在,不计入正向候选的观测要求。
                if not any(
                    resolved_by_id[eid].kind in {EvidenceKind.SOURCE, EvidenceKind.LOG}
                    for eid in candidate.evidence_ids
                ):
                    raise ModelRetry(
                        "positive_without_observed_source: 正向根因候选必须引用至少一条"
                        "源码或日志观测;用户输入引用只能支撑现象存在。"
                    )
        return report
