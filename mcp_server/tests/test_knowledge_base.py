from pathlib import Path

import pytest
from fastmcp import Client

from harmony_knowledge_mcp import (
    Authority,
    KnowledgeBase,
    KnowledgeKind,
    KnowledgeValidationError,
    SearchScope,
    create_knowledge_server,
)
from harmony_knowledge_mcp.retriever import (
    longest_common_substring_length,
    normalize,
    search,
    version_matches,
)
from harmony_knowledge_mcp.server import End

KNOWLEDGE_ROOT = Path(__file__).parents[2] / "knowledge"

# 用例自带的样例条目。断言只依赖它们，不依赖 `knowledge/` 里当前有哪些内容——
# 条目的增删是内容作者的自由，测试跟着碎就是测试的问题。
DEMO_SYMPTOM = "demo-symptom"
DEMO_FACT = "demo-fact"
DEMO_PHRASE = "绘本语音评测失败"
DEMO_ALIAS = "跟读评测没有分数"
DEMO_FACT_DESCRIPTION = f"{DEMO_PHRASE}时录音采样率回落"
DEMO_FACT_ALIAS = "蓝牙耳机接入时录音采样率回落"


@pytest.fixture
def base() -> KnowledgeBase:
    """仓库里的知识库，只用于「能干净加载」这一个 smoke 断言。"""
    instance = KnowledgeBase(KNOWLEDGE_ROOT)
    instance.load()
    return instance


def entry_file(
    tmp_path: Path, directory: str, stem: str, frontmatter: str, body: str = "# 标题"
) -> Path:
    folder = tmp_path / directory
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{stem}.md"
    path.write_text(f"---\n{frontmatter}\n---\n\n{body}\n", encoding="utf-8")
    return path


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


def write_sample_entries(root: Path) -> None:
    """写一套自包含的样例：一条现象 + 一条它引用的事实。

    现象覆盖三端、事实只覆盖鸿蒙并带版本下界，用来验证端/版本的降权与标记。
    """
    entry_file(
        root,
        "symptoms",
        DEMO_SYMPTOM,
        SYMPTOM_FRONTMATTER.format(stem=DEMO_SYMPTOM, symptom=DEMO_PHRASE)
        + f"\naliases:\n  - {DEMO_ALIAS}",
        body=f"# 示例现象\n\n见 [[{DEMO_FACT}]]",
    )
    entry_file(
        root,
        "facts/cloudlearn",
        DEMO_FACT,
        FACT_FRONTMATTER.format(stem=DEMO_FACT, description=DEMO_FACT_DESCRIPTION)
        + f"\naliases:\n  - {DEMO_FACT_ALIAS}"
        + '\napplicable_versions: "5.0-"',
        body="# 示例判据\n\n蓝牙耳机接入时录音采样率回落到 16kHz。",
    )


@pytest.fixture
def sample_base(tmp_path: Path) -> KnowledgeBase:
    write_sample_entries(tmp_path)
    instance = KnowledgeBase(tmp_path)
    instance.load()
    return instance


def test_repository_knowledge_base_loads_without_errors(base: KnowledgeBase) -> None:
    """仓库知识库只需要能干净加载；warning 反映内容状态，不是失败。"""
    errors, _ = base.validate()

    assert errors == []


def test_every_reference_resolves_to_a_fact_entry(sample_base: KnowledgeBase) -> None:
    referencing = [entry for entry in sample_base.all() if entry.references]

    assert referencing, "样例库里至少要有一条带引用的条目"
    for entry in referencing:
        for reference in entry.references:
            referenced = sample_base.get(reference)
            assert referenced is not None, f"{entry.source_path} 引用了不存在的 {reference}"
            assert referenced.kind is not KnowledgeKind.SYMPTOM


def test_vague_user_wording_lands_on_the_symptom_entry(sample_base: KnowledgeBase) -> None:
    hits = search(sample_base.all(), "我的绘本语音评测总是失败", end=End.HARMONY)

    assert hits
    assert hits[0].name == DEMO_SYMPTOM
    assert hits[0].end_match is True


def test_symptom_outranks_fact_at_equal_score(sample_base: KnowledgeBase) -> None:
    """用户原话同时命中现象条目和它下面的事实条目时，入口必须排在最前面。"""
    hits = search(
        sample_base.all(), "我的绘本语音评测总是失败", scope=SearchScope.ALL, end=End.HARMONY
    )

    assert len(hits) >= 2
    assert hits[0].score == hits[1].score, "这个断言的前提是同分，不等分时排序规则是另一回事"
    assert hits[0].kind is KnowledgeKind.SYMPTOM


def test_alias_wording_matches(sample_base: KnowledgeBase) -> None:
    hits = search(sample_base.all(), DEMO_ALIAS, end=End.IOS)

    assert hits[0].name == DEMO_SYMPTOM


def test_unrelated_query_returns_nothing(sample_base: KnowledgeBase) -> None:
    assert search(sample_base.all(), "启动后白屏并抛出 TypeError") == []


def test_end_mismatch_demotes_but_keeps_the_hit(sample_base: KnowledgeBase) -> None:
    query = "蓝牙耳机采样率"
    harmony = search(sample_base.all(), query, scope=SearchScope.FACT, end=End.HARMONY)
    ios = search(sample_base.all(), query, scope=SearchScope.FACT, end=End.IOS)

    matched = [hit for hit in harmony if hit.name == DEMO_FACT]
    mismatched = [hit for hit in ios if hit.name == DEMO_FACT]

    assert matched and matched[0].end_match is True
    assert mismatched, "端不匹配的条目仍应作为线索返回，不能直接丢弃"
    assert mismatched[0].end_match is False
    assert mismatched[0].score < matched[0].score


def test_version_mismatch_is_flagged(sample_base: KnowledgeBase) -> None:
    hits = search(
        sample_base.all(), "蓝牙耳机采样率", scope=SearchScope.FACT, end=End.HARMONY, version="4.0"
    )

    hit = next(item for item in hits if item.name == DEMO_FACT)
    assert hit.end_match is True
    assert hit.version_match is False


def test_scope_filters_entries(sample_base: KnowledgeBase) -> None:
    symptoms = search(sample_base.all(), DEMO_PHRASE, scope=SearchScope.SYMPTOM)
    facts = search(sample_base.all(), DEMO_PHRASE, scope=SearchScope.FACT)

    assert {hit.kind for hit in symptoms} == {KnowledgeKind.SYMPTOM}
    assert facts, "样例库里的事实条目应当能被同一句话命中"
    assert all(hit.kind is not KnowledgeKind.SYMPTOM for hit in facts)


def test_version_range_matching() -> None:
    assert version_matches("5.0-6.0", "5.5") is True
    assert version_matches("5.0-6.0", "6.1") is False
    assert version_matches("5.0-", "9.9") is True
    assert version_matches(None, "5.0") is True
    assert version_matches("5.0-6.0", None) is True


def test_normalize_drops_punctuation() -> None:
    assert normalize("绘本语音评测失败！") == "绘本语音评测失败"


def test_longest_common_substring_length() -> None:
    assert longest_common_substring_length("用户说戴蓝牙耳机就评测不了", "蓝牙耳机") == 4
    assert longest_common_substring_length("abc", "xyz") == 0


def test_filler_heavy_wording_still_reaches_the_fact(sample_base: KnowledgeBase) -> None:
    hits = search(
        sample_base.all(), "用户说戴蓝牙耳机就评测不了", scope=SearchScope.FACT, end=End.HARMONY
    )

    assert hits
    assert hits[0].name == DEMO_FACT


def test_generic_suffix_does_not_match_unrelated_entries(sample_base: KnowledgeBase) -> None:
    """「登录有问题」这类泛化短语不能因为共享「有问题」就命中语音评测条目。"""
    assert search(sample_base.all(), "登录有问题", scope=SearchScope.ALL) == []


def test_validate_rejects_a_name_that_disagrees_with_the_filename(tmp_path: Path) -> None:
    entry_file(
        tmp_path, "symptoms", "wrong-stem", SYMPTOM_FRONTMATTER.format(stem="other", symptom="x")
    )
    entry_file(
        tmp_path, "facts/shared", "a-fact", FACT_FRONTMATTER.format(stem="a-fact", description="y")
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("必须与文件名" in error for error in errors)


def test_validate_rejects_a_broken_reference(tmp_path: Path) -> None:
    entry_file(
        tmp_path,
        "symptoms",
        "a-symptom",
        SYMPTOM_FRONTMATTER.format(stem="a-symptom", symptom="某现象"),
        body="见 [[no-such-fact]]",
    )
    entry_file(
        tmp_path, "facts/shared", "a-fact", FACT_FRONTMATTER.format(stem="a-fact", description="y")
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("无法解析" in error for error in errors)


def test_validate_rejects_kind_outside_its_directory(tmp_path: Path) -> None:
    entry_file(
        tmp_path,
        "symptoms",
        "a-symptom",
        FACT_FRONTMATTER.format(stem="a-symptom", description="y"),
    )
    entry_file(
        tmp_path, "facts/shared", "a-fact", FACT_FRONTMATTER.format(stem="a-fact", description="y")
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("只允许 kind" in error for error in errors)


def test_validate_rejects_missing_frontmatter(tmp_path: Path) -> None:
    (tmp_path / "symptoms").mkdir()
    (tmp_path / "facts").mkdir()
    (tmp_path / "symptoms" / "bare.md").write_text("# 没有 frontmatter\n", encoding="utf-8")

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("缺少 YAML frontmatter" in error for error in errors)


def test_load_raises_on_invalid_knowledge_base(tmp_path: Path) -> None:
    with pytest.raises(KnowledgeValidationError):
        KnowledgeBase(tmp_path).load()


def test_stale_entry_produces_a_warning(tmp_path: Path) -> None:
    entry_file(
        tmp_path,
        "symptoms",
        "old-symptom",
        SYMPTOM_FRONTMATTER.format(stem="old-symptom", symptom="旧现象").replace(
            "verified_at: 2026-08-01", "verified_at: 2020-01-01"
        ),
    )
    entry_file(
        tmp_path, "facts/shared", "a-fact", FACT_FRONTMATTER.format(stem="a-fact", description="y")
    )

    errors, warnings = KnowledgeBase(tmp_path).validate()

    assert errors == []
    assert any("未人工验证" in warning for warning in warnings)


def test_verified_at_may_be_absent(tmp_path: Path) -> None:
    """从未人工验证的条目允许入库：它靠 authority 表明自己是线索，而不是靠伪造日期。"""
    entry_file(
        tmp_path,
        "symptoms",
        "unverified-symptom",
        SYMPTOM_FRONTMATTER.format(stem="unverified-symptom", symptom="未验证现象")
        .replace("\nverified_at: 2026-08-01", "")
        .replace("authority: internal-sop", "authority: auto"),
    )
    entry_file(
        tmp_path, "facts/shared", "a-fact", FACT_FRONTMATTER.format(stem="a-fact", description="y")
    )

    errors, warnings = KnowledgeBase(tmp_path).validate()

    assert errors == []
    assert warnings == []


def test_evidence_authority_without_verification_warns(tmp_path: Path) -> None:
    """写成高可信等级却没有验证日期，说明结论比证据硬，必须告警。"""
    entry_file(
        tmp_path,
        "symptoms",
        "overclaimed-symptom",
        SYMPTOM_FRONTMATTER.format(stem="overclaimed-symptom", symptom="夸大现象").replace(
            "\nverified_at: 2026-08-01", ""
        ),
    )
    entry_file(
        tmp_path, "facts/shared", "a-fact", FACT_FRONTMATTER.format(stem="a-fact", description="y")
    )

    errors, warnings = KnowledgeBase(tmp_path).validate()

    assert errors == []
    assert any("从未人工验证" in warning for warning in warnings)


def test_code_authority_is_accepted(tmp_path: Path) -> None:
    """接缝层知识的证据是随版本发布的代码，需要有自己的等级，不能被降级成工单线索。"""
    entry_file(
        tmp_path,
        "symptoms",
        "a-symptom",
        SYMPTOM_FRONTMATTER.format(stem="a-symptom", symptom="现象"),
    )
    entry_file(
        tmp_path,
        "facts/shared",
        "a-fact",
        FACT_FRONTMATTER.format(stem="a-fact", description="y").replace(
            "authority: official", "authority: code"
        ),
    )

    errors, warnings = KnowledgeBase(tmp_path).validate()
    entry = KnowledgeBase(tmp_path)
    entry.load()

    assert errors == []
    assert warnings == []
    assert entry.get("a-fact").authority is Authority.CODE


@pytest.mark.asyncio
async def test_mcp_server_exposes_catalog_search_and_entry_tools(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off")

    async with Client(server) as client:
        tools = await client.list_tools()
        names = {tool.name for tool in tools}
        catalog = await client.call_tool("list_symptoms", {})
        hits = await client.call_tool("search_knowledge", {"query": DEMO_PHRASE})
        document = await client.call_tool("get_knowledge_entry", {"name": DEMO_FACT})

    assert names == {
        "lookup_issue",
        "list_symptoms",
        "list_knowledge_domains",
        "search_knowledge",
        "get_knowledge_entry",
    }
    assert DEMO_SYMPTOM in str(catalog)
    assert DEMO_SYMPTOM in str(hits)
    assert "16kHz" in str(document)


@pytest.mark.asyncio
async def test_mcp_server_reports_an_unknown_entry(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    server = create_knowledge_server(tmp_path, query_log_path="off")

    async with Client(server) as client:
        with pytest.raises(Exception, match="unknown knowledge entry"):
            await client.call_tool("get_knowledge_entry", {"name": "nope"})


def test_authority_enum_is_stable() -> None:
    assert {item.value for item in Authority} == {
        "official",
        "internal-sop",
        "code",
        "ticket",
        "auto",
    }


def test_moving_fact_between_domains_preserves_id_and_references(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    destination = tmp_path / "facts" / "shared"
    destination.mkdir()
    (tmp_path / "facts" / "cloudlearn" / f"{DEMO_FACT}.md").rename(destination / f"{DEMO_FACT}.md")

    base = KnowledgeBase(tmp_path)
    base.load()

    assert base.get(DEMO_FACT).domains == ["shared"]
    assert base.get(DEMO_FACT).source_path == f"facts/shared/{DEMO_FACT}.md"
    assert base.get(DEMO_SYMPTOM).references == [DEMO_FACT]


def test_duplicate_ids_across_domains_are_rejected(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    entry_file(
        tmp_path,
        "facts/shared",
        DEMO_FACT,
        FACT_FRONTMATTER.format(stem=DEMO_FACT, description="another fact"),
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("条目名重复" in error for error in errors)


@pytest.mark.parametrize("directory", ["facts", "facts/order/deeper", "facts/Bad_Name"])
def test_invalid_fact_layout_is_rejected(tmp_path: Path, directory: str) -> None:
    write_sample_entries(tmp_path)
    entry_file(
        tmp_path,
        directory,
        "bad-layout",
        FACT_FRONTMATTER.format(stem="bad-layout", description="bad layout"),
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("事实必须位于" in error for error in errors)


@pytest.mark.parametrize(
    "domains", ["order", "[Order]", "[1]", "[]", "[payment]", "[order, order]"]
)
def test_invalid_domain_metadata_is_rejected(tmp_path: Path, domains: str) -> None:
    write_sample_entries(tmp_path)
    entry_file(
        tmp_path,
        "facts/order",
        "bad-domains",
        FACT_FRONTMATTER.format(stem="bad-domains", description="bad domains")
        + f"\ndomains: {domains}",
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("domains" in error for error in errors)


def test_path_based_reference_is_rejected(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    entry_file(
        tmp_path,
        "facts/order",
        "bad-link",
        FACT_FRONTMATTER.format(stem="bad-link", description="bad link"),
        body=f"[[cloudlearn/{DEMO_FACT}]]",
    )

    errors, _ = KnowledgeBase(tmp_path).validate()

    assert any("无法解析" in error for error in errors)


@pytest.fixture
def domain_base(tmp_path: Path) -> KnowledgeBase:
    (tmp_path / "symptoms").mkdir()
    for name, domain, metadata in [
        ("a-other", "cloudlearn", ""),
        ("b-payment", "payment", ""),
        ("c-shared", "shared", ""),
        ("d-contract", "contract", "\ndomains: [contract, order]"),
    ]:
        entry_file(
            tmp_path,
            f"facts/{domain}",
            name,
            FACT_FRONTMATTER.format(stem=name, description="付款的时候没有合同") + metadata,
        )
    base = KnowledgeBase(tmp_path)
    base.load()
    return base


def test_domain_preferences_prioritize_candidates_and_shared_without_filtering(
    domain_base: KnowledgeBase,
) -> None:
    hits = search(
        domain_base.all(),
        "付款的时候没有合同",
        scope=SearchScope.FACT,
        domains=["order", "payment"],
        limit=10,
    )

    assert [hit.name for hit in hits] == ["b-payment", "c-shared", "d-contract", "a-other"]
    assert all(hit.domain_match is True for hit in hits[:3])
    assert hits[-1].domain_match is False
    assert len({hit.score for hit in hits}) == 1


def test_domains_cannot_manufacture_matches(domain_base: KnowledgeBase) -> None:
    assert (
        search(domain_base.all(), "人脸识别失败", scope=SearchScope.FACT, domains=["payment"]) == []
    )


def test_stronger_cross_domain_match_beats_weaker_preferred_match(
    domain_base: KnowledgeBase,
) -> None:
    entries = [
        domain_base.get("a-other"),
        domain_base.get("b-payment").model_copy(update={"summary": "付款时"}),
    ]
    hits = search(entries, "付款时没有合同", scope=SearchScope.FACT, domains=["cloudlearn"])

    assert hits[0].name == "b-payment"
    assert hits[0].domain_match is False
    assert hits[0].score > hits[1].score


def test_unrelated_domain_preference_keeps_global_match(sample_base: KnowledgeBase) -> None:
    baseline = search(sample_base.all(), DEMO_FACT_ALIAS, scope=SearchScope.FACT)
    preferred = search(
        sample_base.all(), DEMO_FACT_ALIAS, scope=SearchScope.FACT, domains=["unknown"]
    )
    assert [hit.name for hit in preferred] == [hit.name for hit in baseline] == [DEMO_FACT]
    assert preferred[0].domain_match is False
    assert baseline[0].domain_match is None


@pytest.mark.asyncio
async def test_domains_round_trip_through_mcp(domain_base: KnowledgeBase) -> None:
    server = create_knowledge_server(domain_base.root, query_log_path="off")
    async with Client(server) as client:
        catalog = await client.call_tool("list_knowledge_domains", {})
        result = await client.call_tool(
            "search_knowledge",
            {"query": "付款的时候没有合同", "scope": "fact", "domains": ["order"], "limit": 10},
        )
        document = await client.call_tool("get_knowledge_entry", {"name": "d-contract"})

    assert catalog.data == ["cloudlearn", "contract", "order", "payment", "shared"]
    assert [hit.name for hit in result.data] == [
        "c-shared",
        "d-contract",
        "a-other",
        "b-payment",
    ]
    assert document.data.domains == ["contract", "order"]


@pytest.mark.asyncio
async def test_lookup_bundles_symptom_and_fact_with_bounded_previews(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    fact = tmp_path / "facts" / "cloudlearn" / f"{DEMO_FACT}.md"
    fact.write_text(fact.read_text(encoding="utf-8") + "extra " * 1000, encoding="utf-8")
    async with Client(create_knowledge_server(tmp_path, query_log_path="off")) as client:
        result = await client.call_tool("lookup_issue", {"query": DEMO_PHRASE})

    assert result.data.scope_used == "symptom"
    assert [doc.name for doc in result.data.documents] == [DEMO_SYMPTOM, DEMO_FACT]
    assert sum(len(doc.body) for doc in result.data.documents) <= 4500
    assert result.data.documents[1].truncated
    assert all(doc.leads_only for doc in result.data.documents)


@pytest.mark.asyncio
async def test_lookup_falls_back_to_facts_without_an_extra_model_call(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    async with Client(create_knowledge_server(tmp_path, query_log_path="off")) as client:
        result = await client.call_tool("lookup_issue", {"query": DEMO_FACT_ALIAS})
        missing = await client.call_tool("lookup_issue", {"query": "完全无关的内容"})

    assert result.data.scope_used == "all"
    assert result.data.hits[0].name == DEMO_FACT
    assert result.data.documents[0].name == DEMO_FACT
    assert missing.data.hits == []
    assert missing.data.documents == []


@pytest.mark.asyncio
async def test_entry_pages_recover_the_entire_body_and_final_exception(tmp_path: Path) -> None:
    write_sample_entries(tmp_path)
    fact = tmp_path / "facts" / "cloudlearn" / f"{DEMO_FACT}.md"
    fact.write_text(fact.read_text() + "criterion " * 1000 + "\nTAIL_EXCEPTION", encoding="utf-8")
    base = KnowledgeBase(tmp_path)
    base.load()
    expected = base.get(DEMO_FACT).body
    pages = []
    offset = 0
    async with Client(create_knowledge_server(tmp_path, query_log_path="off")) as client:
        while True:
            result = await client.call_tool(
                "get_knowledge_entry", {"name": DEMO_FACT, "offset": offset}
            )
            page = result.data
            assert page.offset == offset
            assert page.total_chars == len(expected)
            assert len(page.body) <= 2000
            pages.append(page.body)
            if page.next_offset is None:
                break
            assert page.next_offset > offset
            offset = page.next_offset
        for arguments in (
            {"offset": -1},
            {"limit": 0},
            {"limit": 4001},
            {"offset": len(expected) + 1},
        ):
            with pytest.raises(Exception, match="offset|limit|validation"):
                await client.call_tool("get_knowledge_entry", {"name": DEMO_FACT, **arguments})
    assert "".join(pages) == expected
    assert "TAIL_EXCEPTION" in pages[-1]
