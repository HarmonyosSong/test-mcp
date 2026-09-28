"""有类型的版本化检索词表与查询特征抽取(设计文档第 5 节)。

V1 的 CONCEPTS 是无类型同义组,迁移为带类型注册表:类型决定能否独立召回(5.3)。
迁移保持现有词表覆盖(消融 C 的前提);「回放/云听课」「合同/协议」这类相关但
不同的对象拆成不同概念、标 RELATED,不当完全等价。类型标签是初稿,新增词条
留待人工审核(14.1);每组 note 字段是维护依据。

词表只维护「语言如何指向对象」,不复制条目的业务判断。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum


class ConceptKind(StrEnum):
    OBJECT = "object"  # 明确业务对象:可独立召回(返回仍是线索)
    ACTION = "action"  # 动作:不能独立召回,只参与已有候选的排序
    STATE = "state"  # 状态/通用症状:不能独立召回
    RELATED = "related"  # 相关但不同的对象:保留各自 ID,只作相关候选线索
    INTENT = "intent-phrase"  # 受审核意图短语:可独立召回
    PLATFORM = "platform"  # 平台/通用名词:不能独立召回


@dataclass(frozen=True, slots=True)
class Concept:
    concept_id: str
    kind: ConceptKind
    terms: tuple[str, ...]
    related_to: tuple[str, ...] = ()
    note: str = ""


# ---------- 概念注册表(V1 CONCEPTS 25 组的等价迁移 + 通用症状/套话) ----------

CONCEPT_REGISTRY: tuple[Concept, ...] = (
    Concept(
        "error-book",
        ConceptKind.OBJECT,
        ("错题本", "错题集", "错题整理", "课中错题"),
        note="同一对象叫法,V1 error-book 组",
    ),
    Concept(
        "combo-addon",
        ConceptKind.OBJECT,
        ("组合加购", "搭配购课", "班课渗透", "加购"),
        note="同一产品机制叫法;「买正课送体验课」是描述不是叫法,未迁入",
    ),
    Concept(
        "cart",
        ConceptKind.OBJECT,
        ("购课单", "购物车"),
        note="已审核同义:内部称购课单,用户称购物车",
    ),
    # 「合同/协议」拆分(文档 5.3):相关但不同对象,保留各自 ID。
    Concept(
        "contract",
        ConceptKind.OBJECT,
        ("合同",),
        related_to=("agreement",),
        note="合同 ≠ 协议;V1 同组是误并",
    ),
    Concept(
        "agreement",
        ConceptKind.OBJECT,
        ("协议",),
        related_to=("contract",),
        note="收银台协议与合同分属两个来源(order-contract-agreement-sources)",
    ),
    Concept(
        "sign", ConceptKind.ACTION, ("签约", "签字", "签署"), note="动作,从 V1 contract 组拆出"
    ),
    Concept("handout", ConceptKind.OBJECT, ("讲义", "讲议"), note="同义含常见错别字"),
    # 「回放/云听课」拆分:相关但不同对象。
    Concept(
        "replay",
        ConceptKind.OBJECT,
        ("回放", "回看课程"),
        related_to=("cloud-listening",),
        note="回放 ≠ 云听课;V1 同组是误并",
    ),
    Concept(
        "cloud-listening",
        ConceptKind.OBJECT,
        ("云听课",),
        related_to=("replay",),
        note="云听课是独立旁听入口(class-replay-and-cloud-listening)",
    ),
    Concept("notes", ConceptKind.OBJECT, ("课堂笔记", "课后笔记"), note="同一对象叫法"),
    Concept("invoice", ConceptKind.OBJECT, ("发票",), note="对象"),
    Concept("bill", ConceptKind.ACTION, ("开票",), note="动作,从 V1 invoice 组拆出"),
    Concept("coupon", ConceptKind.OBJECT, ("优惠券", "代金券"), note="已审核同义"),
    Concept(
        "coupon-state",
        ConceptKind.STATE,
        ("有券", "叠券", "用券"),
        note="通用状态碎片,从 V1 coupon 组拆出,不独立召回",
    ),
    Concept(
        "trial",
        ConceptKind.OBJECT,
        ("先学后付", "先满意再缴费", "先上课后付费", "体验后缴费"),
        note="同一产品形态的叫法",
    ),
    Concept("ai-assistant", ConceptKind.OBJECT, ("小思ai", "蛋君"), note="同一功能两个名"),
    Concept(
        "speech",
        ConceptKind.OBJECT,
        ("语音评测", "口语测评"),
        related_to=("spoken-island",),
        note="功能对象;口语岛是它的入口,相关不同物",
    ),
    Concept(
        "spoken-island",
        ConceptKind.OBJECT,
        ("口语岛",),
        related_to=("speech",),
        note="语音评测的入口产品(classlearn-spoken-island-entry)",
    ),
    Concept("read-aloud", ConceptKind.ACTION, ("朗读",), note="动作,从 V1 speech 组拆出"),
    Concept("picture-book", ConceptKind.OBJECT, ("绘本", "分级阅读"), note="同一对象叫法"),
    Concept(
        "appraisal",
        ConceptKind.OBJECT,
        ("个人评价", "课程评价", "教师评价", "评论"),
        note="评价类对象;维度差异留待 profile 细化",
    ),
    Concept("one-on-one", ConceptKind.OBJECT, ("1对1", "一对一"), note="已审核同义"),
    Concept("self-study", ConceptKind.OBJECT, ("自学课", "自主学习课程"), note="同一对象叫法"),
    Concept("scan", ConceptKind.OBJECT, ("扫一扫", "扫码", "扫描二维码"), note="同一功能叫法"),
    Concept("app-search", ConceptKind.OBJECT, ("ai搜索", "智能搜索"), note="同一功能叫法"),
    Concept(
        "search-state",
        ConceptKind.STATE,
        ("搜不到", "搜索不准"),
        note="通用状态碎片,从 V1 search 组拆出",
    ),
    Concept("grade", ConceptKind.OBJECT, ("投放年级", "年级显示", "课程年级"), note="同一属性叫法"),
    Concept("classroom", ConceptKind.OBJECT, ("教室号", "具体教室"), note="同一对象叫法"),
    Concept(
        "authorization",
        ConceptKind.OBJECT,
        ("应用授权", "第三方授权", "xnote"),
        note="授权对象;xnote 是触发场景",
    ),
    Concept(
        "face-login", ConceptKind.OBJECT, ("免密登录", "人脸登录", "刷脸登录"), note="同一功能叫法"
    ),
    Concept("programming", ConceptKind.OBJECT, ("编程课堂", "编程课入口"), note="同一功能叫法"),
    Concept("report", ConceptKind.OBJECT, ("学习报告", "学情报告"), note="同一对象叫法"),
    # 业务动作(审计查询驱动补充):不独立召回,用于已有候选的动作覆盖率。
    Concept("refund", ConceptKind.ACTION, ("退款", "退费", "退课"), note="动作"),
    Concept("reschedule", ConceptKind.ACTION, ("调课",), note="动作"),
    Concept("swap", ConceptKind.ACTION, ("转班", "换商品", "换课"), note="动作"),
    Concept("cancel", ConceptKind.ACTION, ("取消", "撤销", "撤回"), note="动作"),
    Concept("delete", ConceptKind.ACTION, ("删除",), note="动作"),
    Concept("download", ConceptKind.ACTION, ("下载", "存成文件", "保存"), note="动作"),
    Concept("enroll", ConceptKind.ACTION, ("报名", "报班"), note="动作"),
    Concept(
        "quota",
        ConceptKind.OBJECT,
        ("名额", "满员", "超员", "超限额"),
        note="班级名额对象(class-quota-and-over-quota)",
    ),
    # 通用症状碎片(审计负例暴露 + 条目 alias 中的通用态):不独立召回。
    Concept(
        "score-missing",
        ConceptKind.STATE,
        ("没有分数", "无分数", "空分数"),
        note="通用状态;「高考查分没有分数」不得据此召回云学习",
    ),
    Concept(
        "blank-screen",
        ConceptKind.STATE,
        ("白屏",),
        note="通用状态;「电脑白屏」不得据此召回 App 条目",
    ),
    Concept(
        "unresponsive",
        ConceptKind.STATE,
        ("没反应", "点了没反应", "打不开", "用不了", "失效"),
        note="通用状态;「点了没反应」缺操作对象,应澄清",
    ),
    # 平台/通用名词:不提供任何区分度。
    Concept(
        "generic-platform",
        ConceptKind.PLATFORM,
        ("app", "页面", "手机", "用户", "功能", "入口"),
        note="平台/通用名词,不独立召回",
    ),
)

# 问句套话:只标记区间,不参与任何计分(治 V1「为什么没有」LCS 满分碰撞)。
QUESTION_SCAFFOLD_RE = re.compile(
    "什么情况下|有哪些|哪几个|哪几种|哪些|多少个|多少种|几个|几种|"
    "能不能|可不可以|为什么没有|怎么办|怎么|如何|什么|是否|为什么|请问|吗|呢"
)

# 技术符号锚点:完整边界、大小写敏感匹配才可召回(文档 5.2.2/5.2.4)。
REGISTERED_SYMBOLS: tuple[str, ...] = (
    "evaluationCheckView",
    "fromTask",
    "isNative",
    "JSBridge",
)

# 数量/单位/角色白名单(文档 5.2.6):只转换登记过的等价,不全局替换数字。
UNIT_FACETS: tuple[tuple[tuple[str, ...], tuple[str, str]], ...] = (
    (("五公里", "5公里", "5km", "5KM"), ("distance", "5km")),
    (("顾问",), ("role", "advisor")),
    (("家长",), ("role", "parent")),
)

_ASCII_TOKEN_RE = re.compile(r"[A-Za-z0-9]+(?:[._:/#@-]+[A-Za-z0-9]+)+|[A-Za-z0-9]+")


def extract_facets(compact_text: str) -> frozenset[tuple[str, str]]:
    """白名单单位归一化(文档 5.2.6):只转换登记过的等价,查询与条目共用。"""
    found: set[tuple[str, str]] = set()
    for variants, facet in UNIT_FACETS:
        for variant in variants:
            if unicodedata.normalize("NFKC", variant).casefold() in compact_text:
                found.add(facet)
    return frozenset(found)


# 预编译:term -> concept,按 term 长度降序实现最长匹配优先(文档 5.2.5)。
_TERM_INDEX: list[tuple[str, Concept]] = sorted(
    (
        (unicodedata.normalize("NFKC", term).casefold(), concept)
        for concept in CONCEPT_REGISTRY
        for term in concept.terms
    ),
    key=lambda item: (-len(item[0]), item[0], item[1].concept_id),
)

_PUNCT_BOUNDARY_RE = re.compile(r"[\s,。!?、;:,;.!?;:~·\-—_()\"'“”【】\[\]（）]+")


def normalize_human_text(value: str) -> str:
    """人类语言通道:NFKC + casefold + 统一空白;标点保留为边界(文档 5.2.1)。"""
    text = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(_PUNCT_BOUNDARY_RE.sub(" ", text).split())


@dataclass(frozen=True, slots=True)
class QueryFeatures:
    """查询表示(文档 5.1);未识别 = 未知,不声称理解了整句。"""

    raw_query: str
    normalized_text: str
    objects: frozenset[str] = frozenset()
    actions: frozenset[str] = frozenset()
    states: frozenset[str] = frozenset()
    intents: frozenset[str] = frozenset()
    symbols: frozenset[str] = frozenset()
    facets: frozenset[tuple[str, str]] = frozenset()
    generic_only: bool = False  # 去空白后只剩套话/通用症状/平台词
    matched_spans: tuple[tuple[int, int], ...] = ()


def analyze_query(query: str) -> QueryFeatures:
    """特征抽取:先完整技术片段,再在人类语言片段上做最长词表匹配(文档 5.2 边界)。

    不做自然语言解析;重叠区间按区间长度降序、起点升序、概念 ID 字典序确定性选择。
    """
    nfkc = unicodedata.normalize("NFKC", query)
    symbols = {
        match.group()
        for match in _ASCII_TOKEN_RE.finditer(nfkc)
        if match.group() in REGISTERED_SYMBOLS
    }
    normalized = normalize_human_text(query)
    compact = normalized.replace(" ", "")
    facets = set(extract_facets(compact))

    hits: list[tuple[int, int, Concept]] = []  # (start, end, concept) 区间不重叠
    occupied = [False] * len(compact)
    for term, concept in _TERM_INDEX:
        start = 0
        while True:
            index = compact.find(term, start)
            if index < 0:
                break
            end = index + len(term)
            if not any(occupied[index:end]):
                hits.append((index, end, concept))
                for position in range(index, end):
                    occupied[position] = True
            start = index + 1

    objects: set[str] = set()
    actions: set[str] = set()
    states: set[str] = set()
    intents: set[str] = set()
    for _, _, concept in hits:
        if concept.kind is ConceptKind.OBJECT:
            objects.add(concept.concept_id)
        elif concept.kind is ConceptKind.ACTION:
            actions.add(concept.concept_id)
        elif concept.kind is ConceptKind.STATE:
            states.add(concept.concept_id)
        elif concept.kind is ConceptKind.INTENT:
            intents.add(concept.concept_id)
        # RELATED/PLATFORM 命中不进入任何召回桶,只留在 matched_spans 供诊断。
    scaffolded = QUESTION_SCAFFOLD_RE.sub("", compact)
    generic_only = not (objects or actions or intents or symbols) and (
        not scaffolded.strip() or bool(states)
    )
    return QueryFeatures(
        raw_query=query,
        normalized_text=normalized,
        objects=frozenset(objects),
        actions=frozenset(actions),
        states=frozenset(states),
        intents=frozenset(intents),
        symbols=frozenset(symbols),
        facets=frozenset(facets),
        generic_only=generic_only,
        matched_spans=tuple(sorted((start, end) for start, end, _ in hits)),
    )


def analyze_entry_text(text: str) -> frozenset[str]:
    """条目侧词表抽取:返回命中的概念 ID 全集(含 RELATED,关联声明用)。"""
    compact = normalize_human_text(text).replace(" ", "")
    found: set[str] = set()
    for term, concept in _TERM_INDEX:
        if term in compact:
            found.add(concept.concept_id)
    return frozenset(found)


def registered_symbols_in(text: str) -> frozenset[str]:
    """条目文本中的完整技术锚点(大小写敏感、完整边界)。"""
    return frozenset(
        match.group()
        for match in _ASCII_TOKEN_RE.finditer(unicodedata.normalize("NFKC", text))
        if match.group() in REGISTERED_SYMBOLS
    )


def rules_digest() -> str:
    """词表/规则内容摘要:进入快照标识,词表变更可据此归因。"""
    import hashlib
    import json

    payload = [
        {
            "id": concept.concept_id,
            "kind": concept.kind.value,
            "terms": list(concept.terms),
            "related_to": list(concept.related_to),
        }
        for concept in CONCEPT_REGISTRY
    ]
    return hashlib.sha256(
        json.dumps({"concepts": payload, "symbols": REGISTERED_SYMBOLS}, sort_keys=True).encode()
    ).hexdigest()
