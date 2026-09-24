from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.toolsets import WrapperToolset
from pydantic_ai.toolsets.abstract import ToolsetTool

from ..domain import ToolEvent
from ..runtimes.evidence import EvidenceLedger

REUSABLE_TOOLS = frozenset(
    {
        "load_skill",
        "lookup_issue",
        "search_knowledge",
        "get_knowledge_entry",
        "list_knowledge_domains",
        "list_symptoms",
        "read_project_file",
        "search_project_text",
        "list_project_files",
        "load_business_context",
        "parse_hilog",
        "resolve_external_knowledge",
        "read_external_knowledge",
    }
)


def _transient(error: Exception) -> bool:
    """Only an explicit upstream flag permits one identical retry; never guess from prose."""
    if getattr(error, "transient", None) is True:
        return True
    data = getattr(getattr(error, "error", None), "data", None)
    if isinstance(data, dict) and data.get("transient") is True:
        return True
    try:
        payload = json.loads(str(error))
    except (ValueError, TypeError):
        return False
    return isinstance(payload, dict) and payload.get("transient") is True


@dataclass
class ToolFailureBudget:
    """One instance per turn, shared by preflight and every toolset in that turn."""

    limit: int = 10
    call_limit: int = 30
    no_progress_limit: int = 4
    failures: list[str] = field(default_factory=list)
    calls: int = 0
    executed: int = 0
    reused: int = 0
    result_chars: int = 0
    no_progress: int = 0
    _successes: dict[str, int] = field(default_factory=dict)
    _result_signatures: set[str] = field(default_factory=set)
    _failed_signatures: dict[str, bool] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        if min(self.limit, self.call_limit, self.no_progress_limit) < 1:
            raise ValueError("tool limits must be positive")

    @property
    def exhausted(self) -> bool:
        return self.stop_reason is not None

    @property
    def stop_reason(self) -> str | None:
        if len(self.failures) >= self.limit:
            return "本轮工具失败预算已耗尽"
        if self.calls >= self.call_limit:
            return "本轮工具调用预算已耗尽"
        if self.no_progress >= self.no_progress_limit:
            return "连续工具调用没有新增信息"
        return None

    def metrics(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "executed": self.executed,
            "reused": self.reused,
            "result_chars": self.result_chars,
            "stop_reason": self.stop_reason,
        }

    async def call(
        self,
        name: str,
        arguments: dict[str, Any],
        operation: Callable[[], Awaitable[Any]],
        events: list[ToolEvent] | None = None,
    ) -> Any:
        # Serialize dispatch so concurrent identical calls cannot race the failure record,
        # and a batch cannot execute beyond the remaining budget.
        async with self._lock:
            started = perf_counter()
            signature = json.dumps(
                [name, arguments], sort_keys=True, ensure_ascii=False, default=str
            )
            failure: str | None = None
            if self.exhausted:
                raise ToolFailed(f"{self.stop_reason}；按已有证据报告缺口或追问。")
            self.calls += 1
            if name in REUSABLE_TOOLS and signature in self._successes:
                self.reused += 1
                self.no_progress += 1
                result = {
                    "reused_from_call": self._successes[signature],
                    "message": "相同调用已完成，请复用本轮已有结果；没有重新执行。",
                }
                self.result_chars += len(json.dumps(result, ensure_ascii=False))
                self._audit(events, name, started, None)
                return result
            if signature in self._failed_signatures and not self._failed_signatures[signature]:
                failure = "同一调用签名已失败，禁止原样重试；请更换有依据的参数或报告证据缺口。"
                self.failures.append(f"{name}: {failure}")
            else:
                retried = signature in self._failed_signatures
                try:
                    self.executed += 1
                    result = await operation()
                except Exception as exc:
                    self._failed_signatures[signature] = not retried and _transient(exc)
                    reason = f"{type(exc).__name__}: {exc}"
                    self.failures.append(f"{name}: {reason}")
                    action = (
                        "上游明确标记瞬时故障，允许同参数重试一次。"
                        if self._failed_signatures[signature]
                        else "禁止原样重试；更换有依据的参数或报告证据缺口。"
                    )
                    failure = f"{reason}。{action}"
                else:
                    if retried:
                        self._failed_signatures[signature] = False
                    serialized = json.dumps(result, sort_keys=True, ensure_ascii=False, default=str)
                    self.result_chars += len(serialized)
                    observed_result = (
                        result["result"]
                        if isinstance(result, dict) and "evidence_refs" in result
                        else result
                    )
                    fingerprint = name + json.dumps(
                        observed_result, sort_keys=True, ensure_ascii=False, default=str
                    )
                    empty = result is None or result == [] or result == ""
                    if isinstance(result, dict):
                        empty = result.get("hits") == [] or result.get("result") == []
                        payload = result.get("result", result)
                        if isinstance(payload, dict):
                            empty = empty or payload.get("status") in {
                                "not_found",
                                "not_covered",
                                "needs_clarification",
                                "response_too_large",
                            }
                    self.no_progress = (
                        self.no_progress + 1
                        if empty or fingerprint in self._result_signatures
                        else 0
                    )
                    self._result_signatures.add(fingerprint)
                    if name in REUSABLE_TOOLS:
                        self._successes[signature] = self.calls
                    if name == "bind_repository":
                        self._successes.clear()
                        self._result_signatures.clear()
                        self._failed_signatures.clear()
                        self.no_progress = 0
                    self._audit(events, name, started, None)
                    return result
            if self.exhausted:
                failure += f" {self.stop_reason}，停止工具调用并给出当前证据与缺口。"
            self._audit(events, name, started, failure)
            raise ToolFailed(failure)

    @staticmethod
    def _audit(
        events: list[ToolEvent] | None, name: str, started: float, failure: str | None
    ) -> None:
        if events is not None:
            duration = max(1, round((perf_counter() - started) * 1_000))
            events.append(
                ToolEvent(
                    tool=name,
                    status="failed" if failure else "completed",
                    summary=f"调用失败：{failure}" if failure else f"调用完成，耗时 {duration} ms",
                    duration_ms=duration,
                )
            )


@dataclass
class BudgetedToolset(WrapperToolset[Any]):
    budget: ToolFailureBudget
    events: list[ToolEvent] | None = None
    ledger: EvidenceLedger | None = None

    async def get_tools(self, ctx: RunContext[Any]) -> dict[str, ToolsetTool[Any]]:
        if self.budget.exhausted:
            return {}
        return await self.wrapped.get_tools(ctx)

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        async def execute() -> Any:
            result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
            if self.ledger is not None:
                result = self.ledger.capture(name, tool_args, result)
            return result

        return await self.budget.call(
            name,
            tool_args,
            execute,
            self.events,
        )
