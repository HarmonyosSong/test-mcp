"""「项目外」软提示契约:零命中 + 已登记外部主体词;提示不参与资格、排序或排除。

词表刻意不收微信(可作 H5 环境)与腾讯会议(已登记为课程工具),夹具不依赖生产条目。
"""

from pathlib import Path

import pytest
from fastmcp import Client
from test_knowledge_base import FACT_FRONTMATTER, entry_file, write_sample_entries
from test_retrieval_boundaries import fact

from harmony_knowledge_mcp import retrieval_rules as rules
from harmony_knowledge_mcp.retrieval_v2 import RetrievalEngine
from harmony_knowledge_mcp.server import create_knowledge_server

HINT = "possible-external-subject"


@pytest.mark.parametrize(
    "query",
    ["淘宝购物车怎么删除", "银行卡刷脸失败", "GitHub搜索不出来仓库", "劳动合同能撤销吗"],
)
def test_external_subject_detected(query):
    assert rules.external_subject_hint(query)


@pytest.mark.parametrize(
    "query",
    [
        "错题本上传失败",  # 项目内问题
        "附近药店",  # 未登记词不提示
        "老师从微信发来的授权链接打不开",  # 微信刻意未登记:可作环境
        "mygithub仓库加载失败",  # 标识符内部不触发
    ],
)
def test_external_subject_not_detected(query):
    assert not rules.external_subject_hint(query)


def test_v2_zero_hit_with_external_subject_carries_hint():
    engine = RetrievalEngine([fact("contract", "合同签署")])
    result = engine.lookup("淘宝购物车里的商品怎么删除")
    assert result.hits == []
    assert HINT in result.reason_codes


def test_v2_generic_query_with_external_subject_carries_hint():
    engine = RetrievalEngine([fact("contract", "合同签署")])
    result = engine.lookup("淘宝不能用了")
    assert result.hits == []
    assert result.status in {"no_match", "insufficient_query"}
    assert HINT in result.reason_codes


def test_v2_hit_with_external_subject_word_never_carries_hint():
    engine = RetrievalEngine([fact("cart", "购课单结算")])
    result = engine.lookup("淘宝的购课单怎么结算")
    assert result.hits
    assert HINT not in result.reason_codes


def test_v2_zero_hit_without_external_subject_has_no_hint():
    engine = RetrievalEngine([fact("contract", "合同签署")])
    result = engine.lookup("错题录入选了PDF以后没有新增题目")
    assert result.hits == []
    assert HINT not in result.reason_codes


@pytest.mark.asyncio
async def test_legacy_zero_hit_carries_hint(tmp_path: Path):
    write_sample_entries(tmp_path)
    entry_file(
        tmp_path,
        "facts/order",
        "contract",
        FACT_FRONTMATTER.format(stem="contract", description="购课合同签署流程"),
        body="## 判据\n以订单页签署状态为准。",
    )
    server = create_knowledge_server(tmp_path, query_log_path="off", retrieval_mode="legacy")
    async with Client(server) as client:
        miss = (
            await client.call_tool("lookup_issue", {"query": "GitHub搜索不出来仓库"})
        ).structured_content
        hit = (
            await client.call_tool("lookup_issue", {"query": "购课合同签署流程"})
        ).structured_content
    assert miss["hits"] == [] and HINT in miss["reason_codes"]
    assert hit["hits"] and HINT not in hit["reason_codes"]


def test_external_subjects_participate_in_rules_digest(monkeypatch):
    before = rules.rules_digest()
    monkeypatch.setattr(
        rules, "EXTERNAL_SUBJECT_TERMS", (*rules.EXTERNAL_SUBJECT_TERMS, "examplecorp")
    )
    assert rules.rules_digest() != before
