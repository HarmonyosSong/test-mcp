"""知识库查询埋点：JSONL 追加日志 + 未命中分析 CLI。

日志是内部遥测，不是 MCP 合同——模型定义留在本模块，不进 schemas.py。
查询文本必须记录（未命中分析、检索基线建设都依赖它），这是对 dev-knowledge
`_call_tool` 只记元数据做法的有意偏离；文本统一截断 MAX_ARGUMENT_LENGTH。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .retrieval_v2 import RETRIEVAL_VERSION_V1, RETRIEVAL_VERSION_V2
from .retriever import CONTAINMENT_SCORE
from .schemas import SearchHit

QUERY_LOG_ENV = "HARMONY_AGENT_KNOWLEDGE_QUERY_LOG"
DEFAULT_QUERY_LOG = ".data/knowledge-queries.jsonl"
MAX_ARGUMENT_LENGTH = 500
MAX_LOGGED_HITS = 5

# FastMCP 的 sync 工具跑在线程池里，锁必须是 threading.Lock（工作线程没有 running loop）。
# 按 resolve 后的绝对路径分锁，避免 ".data/x" 与 "./.data/x" 分裂成两把锁。
_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


class HitRecord(BaseModel):
    name: str
    score: float
    matched_on: str
    end_match: bool
    version_match: bool
    domains: list[str] = Field(default_factory=list)
    domain_match: bool | None = None


class QueryLogEntry(BaseModel):
    """一次工具调用的遥测记录。"""

    ts: str
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    status: str  # "ok" | "error"
    duration_ms: float
    result_count: int | None = None  # list_symptoms
    hit_count: int | None = None  # search_knowledge
    top_score: float | None = None
    hits: list[HitRecord] | None = None
    error: str | None = None
    conversation_id: str | None = None
    message_id: str | None = None
    verdict: str | None = None
    outcome: str | None = None
    # 检索版本化遥测(文档 10.2):缺省为 None,历史行按 lexical-v1 解释。
    retrieval_version: str | None = None
    score_kind: str | None = None
    retrieval_status: str | None = None
    snapshot_id: str | None = None


def resolve_query_log_path(value: str | Path | None = None) -> Path | None:
    """入参 > 环境变量 > 默认路径；"off"/空串 = 关闭（返回 None）。

    关闭语义的唯一出口，agent 侧 Settings 只原样透传字符串，不重复解析。
    """
    raw = value if value is not None else os.environ.get(QUERY_LOG_ENV, DEFAULT_QUERY_LOG)
    text = str(raw).strip()
    if not text or text.casefold() == "off":
        return None
    return Path(text).expanduser()


def _lock_for(path: Path) -> threading.Lock:
    key = path.resolve()
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def _truncate(value: object) -> object:
    if isinstance(value, str) and len(value) > MAX_ARGUMENT_LENGTH:
        return value[:MAX_ARGUMENT_LENGTH]
    return value


class QueryLogger:
    """无状态追加器：不持有 fd、不带缓冲，server 实例创建多少都无害。"""

    def __init__(self, path: Path, *, context: dict[str, str] | None = None) -> None:
        self.path = path
        self.context = context or {}

    def record(self, entry: QueryLogEntry) -> None:
        """永不抛异常：埋点失败绝不能影响工具调用。"""
        try:
            line = entry.model_copy(update=self.context).model_dump_json()
            with _lock_for(self.path):
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as stream:
                    stream.write(line + "\n")
        except Exception as exc:  # noqa: BLE001 — 遥测不许炸业务
            # 必须 stderr：stdio 传输模式下 stdout 是 JSON-RPC 通道。
            print(f"knowledge query log write failed: {exc}", file=sys.stderr)


def summarize_hits(hits: list[SearchHit]) -> dict[str, Any]:
    return {
        "hit_count": len(hits),
        "top_score": hits[0].score if hits else None,
        "hits": [
            HitRecord(
                name=hit.name,
                score=hit.score,
                matched_on=hit.matched_on,
                end_match=hit.end_match,
                version_match=hit.version_match,
                domains=hit.domains,
                domain_match=hit.domain_match,
            )
            for hit in hits[:MAX_LOGGED_HITS]
        ],
    }


def logged_tool(
    logger: QueryLogger | None,
    tool: str,
    operation: Callable[..., Any],
    *args: Any,
    arguments: dict[str, Any] | None = None,
    summarize: Callable[[Any], dict[str, Any]] | None = None,
    **kwargs: Any,
) -> Any:
    """dev-knowledge _call_tool 模式：包裹一次工具调用并记录查询日志。"""
    if logger is None:
        return operation(*args, **kwargs)
    started = time.perf_counter()
    ts = datetime.now(UTC).isoformat(timespec="milliseconds")
    fields: dict[str, Any] = {}
    status = "ok"
    error = None
    try:
        result = operation(*args, **kwargs)
        if summarize is not None:
            fields = summarize(result)
        return result
    except Exception as exc:
        status = "error"
        error = f"{type(exc).__name__}: {exc}"[:MAX_ARGUMENT_LENGTH]
        raise
    finally:
        logger.record(
            QueryLogEntry(
                ts=ts,
                tool=tool,
                arguments={key: _truncate(value) for key, value in (arguments or {}).items()},
                status=status,
                duration_ms=round((time.perf_counter() - started) * 1000, 3),
                error=error,
                **fields,
            )
        )


# ---------- 未命中分析 CLI ----------


def _print_v2_status(searches: list[QueryLogEntry]) -> None:
    """V2 结果按 retrieval_status 分类;分数是 0-1 相关性,不能套 V1 的 2.7 阈值。"""
    if not searches:
        return
    print(f"\nV2 检索状态分布（{len(searches)} 次）——按 retrieval_status 分类：")
    for status_value, count in Counter(
        entry.retrieval_status or "未记录" for entry in searches
    ).most_common():
        print(f"  {status_value}: {count}")
    missed = [
        entry for entry in searches if entry.retrieval_status in {"no_match", "insufficient_query"}
    ]
    counter = Counter(_query_of(entry) for entry in missed)
    if counter:
        print("  其中无匹配/信息不足查询（条目建设清单来源）：")
        for query, count in counter.most_common(20):
            print(f"    {count:>4} 次  {query}")


def _read_entries(path: Path) -> tuple[list[QueryLogEntry], int]:
    """逐行解析，坏行跳过并计数（日志文件可能被截断或手工编辑）。"""
    entries: list[QueryLogEntry] = []
    bad = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entries.append(QueryLogEntry.model_validate(json.loads(line)))
        except ValueError:
            bad += 1
    return entries, bad


def _query_of(entry: QueryLogEntry) -> str:
    value = entry.arguments.get("query")
    return str(value) if value is not None else "<无 query>"


def _print_missed(searches: list[QueryLogEntry]) -> None:
    missed = [entry for entry in searches if entry.hit_count == 0]
    counter = Counter(_query_of(entry) for entry in missed)
    latest = {query: entry.ts for entry in missed for query in [_query_of(entry)]}
    print(f"\n未命中查询（{len(missed)} 次，{len(counter)} 个问法）——条目建设清单来源：")
    if not counter:
        print("  无")
    for query, count in counter.most_common():
        print(f"  {count:>4} 次  {query}  （最近：{latest[query]}）")


def _print_weak(searches: list[QueryLogEntry]) -> None:
    # 弱命中 = 有结果但没有任何短语/包含级命中。端/版本降权会把强命中压到阈值以下，
    # 两种情况分开列：被降权的说明问法对了但上下文不匹配，纯词法弱的才指向别名缺口。
    weak = [
        entry
        for entry in searches
        if (entry.hit_count or 0) > 0
        and entry.top_score is not None
        and entry.top_score < CONTAINMENT_SCORE
    ]

    def downgraded(entry: QueryLogEntry) -> bool:
        return bool(entry.hits and (not entry.hits[0].end_match or not entry.hits[0].version_match))

    penalized = [entry for entry in weak if downgraded(entry)]
    lexical = [entry for entry in weak if not downgraded(entry)]
    print(f"\n弱命中查询（{len(weak)} 次，top_score < {CONTAINMENT_SCORE}）：")
    if not weak:
        print("  无")
        return
    for label, group in (("纯词法弱（疑似缺别名/缺条目）", lexical), ("端/版本降权", penalized)):
        if not group:
            continue
        print(f"  {label}：")
        for query, count in Counter(_query_of(entry) for entry in group).most_common():
            print(f"    {count:>4} 次  {query}")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    path = resolve_query_log_path(Path(args[0]) if args else None)
    if path is None:
        print("查询日志已关闭（off）。")
        return 0
    if not path.exists():
        print(f"暂无查询日志：{path}")
        return 0
    entries, bad = _read_entries(path)
    tool_counts = Counter(entry.tool for entry in entries)
    error_count = sum(1 for entry in entries if entry.status == "error")
    print(f"查询日志：{path}")
    print(f"总调用 {len(entries)} 次（错误 {error_count} 次，坏行 {bad} 行）")
    for tool, count in sorted(tool_counts.items()):
        print(f"  {tool}: {count}")
    searches = [
        entry
        for entry in entries
        if entry.tool in {"search_knowledge", "lookup_issue"} and entry.status == "ok"
    ]
    # 版本分流(文档 10.3):历史行缺版本字段,按 V1 解释;V2 按状态分类;未知版本不套阈值。
    v1_searches: list[QueryLogEntry] = []
    v2_searches: list[QueryLogEntry] = []
    unknown_versions: Counter[str] = Counter()
    for entry in searches:
        version = entry.retrieval_version or RETRIEVAL_VERSION_V1
        if version == RETRIEVAL_VERSION_V1:
            v1_searches.append(entry)
        elif version == RETRIEVAL_VERSION_V2:
            v2_searches.append(entry)
        else:
            unknown_versions[version] += 1
    _print_missed(v1_searches)
    _print_weak(v1_searches)
    _print_v2_status(v2_searches)
    if unknown_versions:
        print(f"\n无法分类的检索版本（{sum(unknown_versions.values())} 次），不套用任何已知阈值：")
        for version, count in unknown_versions.most_common():
            print(f"  {version}: {count}")
    outcomes = [entry for entry in entries if entry.tool == "diagnosis_outcome"]
    if outcomes:
        print("\n诊断终态（模型报告 verdict，不代表人工确认根因）：")
        for verdict, count in Counter(
            entry.verdict or "未提交报告" for entry in outcomes
        ).most_common():
            print(f"  {verdict}: {count}")
        print("  人工复核结果按 conversation_id/message_id 关联 knowledge-cases 中的 review。")
    return 0


def _entrypoint() -> None:
    raise SystemExit(main())
