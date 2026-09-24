"""查询埋点测试：日志是未命中分析和检索基线的数据来源，字段必须钉死。"""

import json
import threading
from pathlib import Path

import pytest
from fastmcp import Client

from harmony_knowledge_mcp import create_knowledge_server
from harmony_knowledge_mcp.query_log import (
    DEFAULT_QUERY_LOG,
    MAX_ARGUMENT_LENGTH,
    QUERY_LOG_ENV,
    QueryLogEntry,
    QueryLogger,
    main,
    resolve_query_log_path,
)
from harmony_knowledge_mcp.query_log import (
    _read_entries as read_entries,
)

SYMPTOM_FRONTMATTER = """name: {stem}
kind: symptom
symptom: {symptom}
applies_to: [harmony, ios, android]
authority: internal-sop
updated_at: 2026-08-01
verified_at: 2026-08-01"""

FACT_FRONTMATTER = """name: {stem}
kind: platform-fact
description: {description}
applies_to: [harmony]
authority: official
updated_at: 2026-08-01
verified_at: 2026-08-01"""


def entry_file(tmp_path: Path, directory: str, stem: str, frontmatter: str, body: str) -> Path:
    folder = tmp_path / directory
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{stem}.md"
    path.write_text(f"---\n{frontmatter}\n---\n\n{body}\n", encoding="utf-8")
    return path


@pytest.fixture
def knowledge_root(tmp_path: Path) -> Path:
    # loader 要求 symptoms/ 与 facts/ 两个目录都存在，缺一个直接拒绝加载。
    entry_file(
        tmp_path,
        "symptoms",
        "speech-eval-failure",
        SYMPTOM_FRONTMATTER.format(stem="speech-eval-failure", symptom="语音评测失败"),
        "# 语音评测失败",
    )
    entry_file(
        tmp_path,
        "facts/cloudlearn",
        "audio-fact",
        FACT_FRONTMATTER.format(stem="audio-fact", description="音频事实"),
        "# 音频事实",
    )
    return tmp_path


@pytest.fixture
def log_path(tmp_path: Path) -> Path:
    return tmp_path / "logs" / "queries.jsonl"


async def call(server, tool: str, arguments: dict) -> None:
    async with Client(server) as client:
        await client.call_tool(tool, arguments)


def logged_entries(path: Path) -> list[QueryLogEntry]:
    entries, bad = read_entries(path)
    assert bad == 0
    return entries


class TestResolveQueryLogPath:
    def test_explicit_argument_wins(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(QUERY_LOG_ENV, "from-env.jsonl")
        assert resolve_query_log_path(tmp_path / "x.jsonl") == tmp_path / "x.jsonl"

    def test_env_beats_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(QUERY_LOG_ENV, "from-env.jsonl")
        assert resolve_query_log_path() == Path("from-env.jsonl")

    def test_default_when_nothing_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(QUERY_LOG_ENV, raising=False)
        assert resolve_query_log_path() == Path(DEFAULT_QUERY_LOG)

    @pytest.mark.parametrize("value", ["off", "OFF", "", "  "])
    def test_off_disables(self, value: str) -> None:
        assert resolve_query_log_path(value) is None

    def test_env_off_disables(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(QUERY_LOG_ENV, "off")
        assert resolve_query_log_path() is None


class TestToolLogging:
    async def test_hit_query_logged_with_hit_fields(
        self, knowledge_root: Path, log_path: Path
    ) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path=log_path)

        await call(server, "search_knowledge", {"query": "语音评测失败"})

        (entry,) = logged_entries(log_path)
        assert entry.tool == "search_knowledge"
        assert entry.status == "ok"
        assert entry.arguments["query"] == "语音评测失败"
        assert entry.hit_count == 1
        assert entry.top_score is not None and entry.top_score > 0
        (hit,) = entry.hits or []
        assert hit.name == "speech-eval-failure"
        assert hit.matched_on
        assert hit.end_match and hit.version_match
        assert entry.duration_ms >= 0
        json.dumps(entry.ts)  # ts 是可序列化的 ISO 字符串

    async def test_miss_query_logged_with_zero_hits(
        self, knowledge_root: Path, log_path: Path
    ) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path=log_path)

        await call(server, "search_knowledge", {"query": "订单重复扣款"})

        (entry,) = logged_entries(log_path)
        assert entry.hit_count == 0
        assert entry.hits == []
        assert entry.top_score is None

    async def test_error_logged_and_reraised(self, knowledge_root: Path, log_path: Path) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path=log_path)

        with pytest.raises(Exception, match="unknown knowledge entry"):
            await call(server, "get_knowledge_entry", {"name": "nope"})

        (entry,) = logged_entries(log_path)
        assert entry.status == "error"
        assert entry.error is not None and "unknown knowledge entry" in entry.error
        assert entry.arguments["name"] == "nope"

    async def test_logging_disabled_writes_nothing(
        self, knowledge_root: Path, tmp_path: Path
    ) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path="off")

        await call(server, "search_knowledge", {"query": "语音评测失败"})

        assert list(tmp_path.rglob("*.jsonl")) == []

    async def test_unwritable_path_does_not_break_the_tool(
        self, knowledge_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # 日志路径指向一个已存在的目录，open("a") 必抛 IsADirectoryError——比 chmod 跨平台稳。
        server = create_knowledge_server(knowledge_root, query_log_path=tmp_path)

        async with Client(server) as client:
            result = await client.call_tool("search_knowledge", {"query": "语音评测失败"})

        assert "speech-eval-failure" in str(result)
        assert "knowledge query log write failed" in capsys.readouterr().err

    async def test_long_query_truncated(self, knowledge_root: Path, log_path: Path) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path=log_path)

        await call(server, "search_knowledge", {"query": "长" * 1000})

        (entry,) = logged_entries(log_path)
        assert len(entry.arguments["query"]) == MAX_ARGUMENT_LENGTH

    async def test_list_symptoms_logged_with_result_count(
        self, knowledge_root: Path, log_path: Path
    ) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path=log_path)

        await call(server, "list_symptoms", {})

        (entry,) = logged_entries(log_path)
        assert entry.tool == "list_symptoms"
        assert entry.result_count == 1
        assert entry.hit_count is None

    async def test_domain_preference_and_hit_context_are_logged(
        self, knowledge_root: Path, log_path: Path
    ) -> None:
        server = create_knowledge_server(knowledge_root, query_log_path=log_path)
        await call(server, "list_knowledge_domains", {})
        await call(
            server,
            "search_knowledge",
            {"query": "音频事实", "scope": "fact", "domains": ["cloudlearn"]},
        )

        catalog, query = logged_entries(log_path)
        assert catalog.result_count == 1
        assert query.arguments["domains"] == ["cloudlearn"]
        assert query.hits[0].domains == ["cloudlearn"]
        assert query.hits[0].domain_match is True


def test_concurrent_appends_produce_whole_lines(log_path: Path) -> None:
    """工具跑在线程池里，并发追加必须靠锁保证每行完整。"""
    loggers = [QueryLogger(log_path) for _ in range(4)]

    def append(logger: QueryLogger, index: int) -> None:
        for round_ in range(10):
            logger.record(
                QueryLogEntry(
                    ts="2026-09-21T00:00:00.000+00:00",
                    tool="search_knowledge",
                    arguments={"query": f"线程{index}-第{round_}次"},
                    status="ok",
                    duration_ms=1.0,
                )
            )

    threads = [
        threading.Thread(target=append, args=(logger, index))
        for index, logger in enumerate(loggers)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    entries = logged_entries(log_path)
    assert len(entries) == 40
    assert {entry.arguments["query"] for entry in entries} == {
        f"线程{index}-第{round_}次" for index in range(4) for round_ in range(10)
    }


class TestQuerylogCli:
    def write_lines(self, path: Path, entries: list[QueryLogEntry]) -> None:
        path.write_text(
            "".join(entry.model_dump_json() + "\n" for entry in entries), encoding="utf-8"
        )

    def entry(self, tool: str, query: str | None, **fields: object) -> QueryLogEntry:
        return QueryLogEntry(
            ts="2026-09-21T00:00:00.000+00:00",
            tool=tool,
            arguments={"query": query} if query is not None else {},
            status="ok",
            duration_ms=1.0,
            **fields,  # type: ignore[arg-type]
        )

    def test_aggregates_misses_by_query(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        path = tmp_path / "q.jsonl"
        self.write_lines(
            path,
            [
                self.entry("search_knowledge", "订单重复扣款", hit_count=0, hits=[]),
                self.entry("search_knowledge", "订单重复扣款", hit_count=0, hits=[]),
                self.entry("search_knowledge", "退款详情加载不出来", hit_count=0, hits=[]),
                self.entry(
                    "search_knowledge",
                    "语音评测失败",
                    hit_count=1,
                    top_score=3.0,
                    hits=[],
                ),
                self.entry("list_symptoms", None, result_count=3),
            ],
        )

        assert main([str(path)]) == 0

        out = capsys.readouterr().out
        assert "总调用 5 次" in out
        # 高频未命中排在前面
        assert out.index("订单重复扣款") < out.index("退款详情加载不出来")
        assert "2 次" in out

    def test_tolerates_corrupt_lines(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        path = tmp_path / "q.jsonl"
        good = self.entry("search_knowledge", "评测失败", hit_count=0, hits=[])
        path.write_text(good.model_dump_json() + "\n这不是 json\n\n", encoding="utf-8")

        assert main([str(path)]) == 0

        out = capsys.readouterr().out
        assert "坏行 1 行" in out
        assert "评测失败" in out

    def test_reports_off(self, capsys: pytest.CaptureFixture[str]) -> None:
        assert main(["off"]) == 0
        assert "已关闭" in capsys.readouterr().out

    def test_reports_missing_file(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        assert main([str(tmp_path / "none.jsonl")]) == 0
        assert "暂无查询日志" in capsys.readouterr().out


def test_lookup_misses_are_in_construction_queue_and_errors_are_separate(tmp_path, capsys):
    path = tmp_path / "queries.jsonl"
    logger = QueryLogger(path, context={"conversation_id": "conv-test", "message_id": "msg-test"})
    logger.record(
        QueryLogEntry(
            ts="2026-09-24",
            tool="lookup_issue",
            arguments={"query": "组合加购"},
            status="ok",
            duration_ms=1,
            hit_count=0,
        )
    )
    logger.record(
        QueryLogEntry(
            ts="2026-09-24",
            tool="lookup_issue",
            arguments={"query": "网络失败"},
            status="error",
            duration_ms=1,
            hit_count=0,
        )
    )
    main([str(path)])
    output = capsys.readouterr().out
    assert "组合加购" in output
    assert "网络失败" not in output
    assert logged_entries(path)[0].conversation_id == "conv-test"
    assert logged_entries(path)[0].message_id == "msg-test"
