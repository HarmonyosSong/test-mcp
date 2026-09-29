from __future__ import annotations

import asyncio
import json
import re
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

# 搜索类工具:结果路径集无新增时计入 no_progress(见下方判定注释)。
_SEARCH_TOOLS = frozenset({"search_project_text", "search_knowledge"})

# 工具默认参数表:签名规范化时先补默认再序列化,避免「省略默认 limit」与
# 「显式传同值」被当成两次不同调用。与 chat_workspace.py / mcp_server 的
# 工具定义同步维护——工具默认值变更时必须更新本表。
_DEFAULT_ARGS: dict[str, dict[str, Any]] = {
    "search_project_text": {"file_glob": "**/*", "limit": 50},
    "read_project_file": {"start_line": 1, "end_line": 200},
    "list_project_files": {"pattern": "**/*", "limit": 100},
    "search_knowledge": {"scope": "symptom", "limit": 3},
    "get_knowledge_entry": {"offset": 0, "limit": 2000},
}

# bind_repository 返回文本里的 commit 段("…(commit 6919c027f1d8),…")。
_BIND_COMMIT = re.compile(r"commit ([0-9a-f]{7,40})")


def _canonical_signature(name: str, arguments: dict[str, Any]) -> str:
    merged = {**_DEFAULT_ARGS.get(name, {}), **arguments}
    return json.dumps([name, merged], sort_keys=True, ensure_ascii=False, default=str)


@dataclass(slots=True)
class CachedCall:
    """成功调用的缓存记录:不止调用序号,还带快照代次与证据引用。

    snapshot_generation 用于「换快照才失效」:重绑同一 commit 是幂等的,
    不该清掉仍有效的缓存;换了 commit 后旧缓存不得再复用。
    evidence_refs 让复用响应能带回当时的证据 ID;复用前会核对这些 ID
    仍在本轮账本里,已淘汰则缓存失效、允许一次真实重读(重读同内容
    会得到同一内容哈希 ID,观测随之恢复)。
    """

    call_index: int
    snapshot_generation: int
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)


# 预算将尽阈值:剩余调用不超过此值时,在成功结果里附收尾提示。
# 让模型主动收敛(停止开新线索、用已有证据写结论),而不是耗尽瞬间被
# 清空工具表——后者会让模型在异常状态下输出协议垃圾(DSML 崩溃的诱因)。
WARN_REMAINING_CALLS = 5

_BUDGET_NOTICE = (
    "工具预算仅剩 {remaining} 次。请停止开启新线索,用已收集的证据收尾并输出结论;"
    "证据不足则如实说明缺口并追问。"
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
    _result_signatures: set[str] = field(default_factory=set)
    _failed_signatures: dict[str, bool] = field(default_factory=dict)
    # 成功调用缓存(签名 → 记录);替代旧的「序号 + 载荷」两张表。
    _cache: dict[str, CachedCall] = field(default_factory=dict)
    # 每个搜索工具累计见过的「文件:行」集合,用于「换词绕圈」判定。
    _search_seen: dict[str, set[str]] = field(default_factory=dict)
    # 快照代次与当前绑定 commit:bind_repository 成功且 commit 变化时递增,
    # 轮内重绑同一 commit 是幂等操作,不清缓存。
    _snapshot_generation: int = 0
    _bound_commit: str | None = None
    # 缓存失效后真实重读并成功恢复观测的次数(指标 evidence_restored)。
    restored: int = 0
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
            "evidence_restored": self.restored,
            "stop_reason": self.stop_reason,
        }

    async def call(
        self,
        name: str,
        arguments: dict[str, Any],
        operation: Callable[[], Awaitable[Any]],
        events: list[ToolEvent] | None = None,
        ledger: EvidenceLedger | None = None,
    ) -> Any:
        # Serialize dispatch so concurrent identical calls cannot race the failure record,
        # and a batch cannot execute beyond the remaining budget.
        async with self._lock:
            started = perf_counter()
            signature = _canonical_signature(name, arguments)
            failure: str | None = None
            if self.exhausted:
                raise ToolFailed(f"{self.stop_reason}；按已有证据报告缺口或追问。")
            self.calls += 1
            if name in REUSABLE_TOOLS and signature in self._cache:
                cached = self._cache[signature]
                # 复用前核对依赖:快照代次须一致,且当时的证据引用仍在账本里。
                # 证据已被淘汰时缓存失效、落到下方真实重读——不能既阻止重读
                # 又要求引用失效 ID;重读同内容得到同一内容哈希 ID,观测即恢复。
                stale_evidence = (
                    ledger is not None
                    and cached.evidence_refs
                    and any(ref.get("id") not in ledger.entries for ref in cached.evidence_refs)
                )
                if cached.snapshot_generation == self._snapshot_generation and not stale_evidence:
                    self.reused += 1
                    self.no_progress += 1
                    result = {
                        "reused_from_call": cached.call_index,
                        "message": "相同调用已完成，请复用本轮已有结果；没有重新执行。",
                    }
                    if cached.evidence_refs:
                        result["evidence_refs"] = cached.evidence_refs
                    self.result_chars += len(json.dumps(result, ensure_ascii=False))
                    self._audit(events, name, started, None)
                    return result
                del self._cache[signature]
                cache_invalidated = True
            else:
                cache_invalidated = False
            if signature in self._failed_signatures and not self._failed_signatures[signature]:
                failure = "同一调用签名已失败，禁止原样重试；请更换有依据的参数或报告证据缺口。"
                self.failures.append(f"{name}: {failure}")
            else:
                retried = signature in self._failed_signatures
                try:
                    self.executed += 1
                    restored_before = ledger.restored_count if ledger is not None else 0
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
                    # 搜索结果集无新增同样是无进展:「换个词再搜」若返回的还是同一批
                    # 文件,等于没有新信息(实测 wrongBook/cuotiben 式换词绕圈;只认
                    # 空结果与重复指纹的旧判定永远抓不到有结果但不相关的搜索)。
                    search_stale = False
                    if name in _SEARCH_TOOLS and isinstance(observed_result, list):
                        # 信息单位是「文件+行」,不是文件:同文件 140 行外新命中 317 行
                        # 算新信息;知识检索无行号,退回条目名。
                        observed_keys = {
                            (
                                f"{row['path']}:{row.get('line', '')}"
                                if row.get("path")
                                else str(row.get("name") or "")
                            )
                            for row in observed_result
                            if isinstance(row, dict)
                        } - {""}
                        if observed_keys:
                            seen = self._search_seen.setdefault(name, set())
                            if seen and not (observed_keys - seen):
                                search_stale = True
                            seen.update(observed_keys)
                    # 判定必须先于 fingerprint 登记:重复指纹指「与历史结果相同」,
                    # 登记后再查会永远命中自己。
                    if empty or fingerprint in self._result_signatures or search_stale:
                        self.no_progress += 1
                    else:
                        self.no_progress = 0
                    self._result_signatures.add(fingerprint)
                    if name in REUSABLE_TOOLS:
                        refs = result.get("evidence_refs") if isinstance(result, dict) else None
                        self._cache[signature] = CachedCall(
                            call_index=self.calls,
                            snapshot_generation=self._snapshot_generation,
                            evidence_refs=list(refs) if refs else [],
                        )
                    if name == "bind_repository":
                        # 只有确实换了快照才失效缓存与进度状态;重绑同一 commit
                        # 是幂等的,有效缓存保留。提取不到 commit 时无法证明
                        # 同快照,按保守策略视为已切换。
                        matched = _BIND_COMMIT.search(result) if isinstance(result, str) else None
                        commit = matched.group(1) if matched else None
                        if commit is None or commit != self._bound_commit:
                            self._cache.clear()
                            self._result_signatures.clear()
                            self._failed_signatures.clear()
                            self._search_seen.clear()
                            self.no_progress = 0
                            self._snapshot_generation += 1
                            self._bound_commit = commit
                    # 缓存失效触发的真实重读若恢复了被淘汰的观测(同内容同 ID),
                    # 这是一次有效修复而非绕圈:单独计量,不计入无进展。
                    if (
                        cache_invalidated
                        and ledger is not None
                        and ledger.restored_count > restored_before
                    ):
                        self.restored += 1
                        self.no_progress = 0
                    # 将尽预警:在真实执行成功的结果上附收尾提示(fingerprint/empty
                    # 判定均在附加前完成,不受影响;复用返回保持固定格式不附加)。
                    remaining = self.call_limit - self.calls
                    if 0 < remaining <= WARN_REMAINING_CALLS:
                        notice = _BUDGET_NOTICE.format(remaining=remaining)
                        if isinstance(result, dict):
                            result = {**result, "budget_notice": notice}
                        else:
                            result = {"result": result, "budget_notice": notice}
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
            ledger=self.ledger,
        )
