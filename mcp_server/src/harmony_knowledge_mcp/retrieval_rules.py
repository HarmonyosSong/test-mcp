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
from collections.abc import Collection
from dataclasses import dataclass
from enum import StrEnum


class ConceptKind(StrEnum):
    OBJECT = "object"  # 明确业务对象:可独立召回(返回仍是线索)
    ACTION = "action"  # 动作:不能独立召回,只参与已有候选的排序
    STATE = "state"  # 状态/通用症状:不能独立召回
    RELATED = "related"  # 相关但不同的对象:保留各自 ID,只作相关候选线索
    INTENT = "intent-phrase"  # 受审核意图短语:可独立召回
    PLATFORM = "platform"  # 平台/通用名词:不能独立召回
    FACET = "facet"  # 地点、界面形态等限定条件,不能独立充当业务对象


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
        ("错题本", "错题集", "错题整理", "课中错题", "错题录入", "上传错题"),
        note="同一对象叫法,V1 error-book 组",
    ),
    Concept(
        "combo-addon",
        ConceptKind.OBJECT,
        ("组合加购", "搭配购课", "班课渗透", "加购", "组合下单", "组合购买"),
        note="同一产品机制叫法;「买正课送体验课」是描述不是叫法,未迁入;"
        "「组合下单/组合购买」F 二轮补(one-on-one-full-care-package)",
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
        ("合同", "签约入口"),
        related_to=("agreement",),
        note="合同 ≠ 协议;V1 同组是误并;「签约入口」F 审核补(2026-09-28)",
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
    Concept(
        "invoice",
        ConceptKind.OBJECT,
        ("发票", "开票入口", "开票按钮"),
        note="对象;开票入口类 F 审核补(2026-09-28)",
    ),
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
        ("个人评价", "课程评价", "教师评价", "评论", "我的评价"),
        note="评价类对象;维度差异留待 profile 细化;「我的评价」F 审核补(2026-09-28)",
    ),
    Concept("one-on-one", ConceptKind.OBJECT, ("1对1", "一对一"), note="已审核同义"),
    Concept("self-study", ConceptKind.OBJECT, ("自学课", "自主学习课程"), note="同一对象叫法"),
    Concept("scan", ConceptKind.OBJECT, ("扫一扫", "扫码", "扫描二维码"), note="同一功能叫法"),
    Concept(
        "app-search", ConceptKind.FACET, ("ai搜索", "智能搜索"), note="跨产品通用功能,需业务场景"
    ),
    Concept(
        "search-state",
        ConceptKind.STATE,
        ("搜不到", "搜索不准"),
        note="通用状态碎片,从 V1 search 组拆出",
    ),
    Concept("grade", ConceptKind.OBJECT, ("投放年级", "年级显示", "课程年级"), note="同一属性叫法"),
    Concept(
        "classroom",
        ConceptKind.OBJECT,
        ("教室号", "具体教室", "教室"),
        note="同一对象叫法;「教室」F 审核补(2026-09-28)",
    ),
    Concept(
        "authorization",
        ConceptKind.OBJECT,
        ("应用授权", "第三方授权", "xnote"),
        note="授权对象;xnote 是触发场景",
    ),
    Concept(
        "face-login",
        ConceptKind.OBJECT,
        ("免密登录", "人脸登录", "刷脸登录", "人脸识别", "人脸"),
        note="同一功能叫法;「人脸/人脸识别」F 审核补(2026-09-28)",
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
    Concept(
        "transfer-in",
        ConceptKind.ACTION,
        ("上传", "录入", "导入"),
        note="输入方向动作,只区分已匹配对象的任务,不独立召回",
    ),
    Concept(
        "transfer-out",
        ConceptKind.ACTION,
        ("导出",),
        note="输出方向动作,与录入分开;不能由导出能力推断支持导入",
    ),
    Concept("enroll", ConceptKind.ACTION, ("报名", "报班"), note="动作"),
    Concept(
        "combine",
        ConceptKind.ACTION,
        ("叠加", "一起用", "同时用"),
        note="动作,F 审核补(2026-09-28):区分优惠券叠加与单券不可用,不扩召回面",
    ),
    Concept(
        "purchase",
        ConceptKind.ACTION,
        ("购买", "买课", "报课"),
        note="动作,F 审核补(2026-09-28):区分「怎么买」类查询,单字「买」不补",
    ),
    # 2026-09-28 F 阶段审核新增业务对象：
    # 以产品/业务术语为主,误放面小;通用度中等的词在 note 标注依据。
    Concept(
        "cloudlearn-study",
        ConceptKind.OBJECT,
        ("云学习",),
        related_to=("cloud-listening",),
        note="云学习 ≠ 云听课;cloudlearn-h5-surfaces",
    ),
    Concept(
        "study-home",
        ConceptKind.OBJECT,
        ("学习页", "学习首页"),
        note="库内高频词;study-home-redesign、harmony-phase1-learning-task-mask",
    ),
    Concept(
        "class-mode",
        ConceptKind.OBJECT,
        ("智慧伴学", "智能伴学", "组合小班"),
        note="产品功能名;class-mode-vs-interaction-mode",
    ),
    Concept(
        "course-state",
        ConceptKind.OBJECT,
        ("课态", "学习空间"),
        note="业务术语;coursestate-mapping",
    ),
    Concept(
        "lesson-type",
        ConceptKind.OBJECT,
        ("选修课", "选修讲", "三讲一测"),
        note="lesson-type-and-livetype-codes",
    ),
    Concept(
        "small-stove",
        ConceptKind.OBJECT,
        ("小灶课", "第0课", "第零课"),
        note="课程对象;腾讯会议是工具限定,不能与小灶课等价",
    ),
    Concept("renewal", ConceptKind.OBJECT, ("续报",), note="业务术语;renewal-cross-business-line"),
    Concept(
        "praise-wall",
        ConceptKind.OBJECT,
        ("表扬墙",),
        related_to=("teacher-homepage",),
        note="产品功能名;teacher-praise-wall",
    ),
    Concept("koubei", ConceptKind.OBJECT, ("口碑值",), note="产品术语;teacher-rating-system"),
    Concept(
        "bixin",
        ConceptKind.OBJECT,
        ("彼芯", "彼芯教练"),
        note="产品术语;virtual-teacher-naming",
    ),
    Concept(
        "three-plus-x",
        ConceptKind.OBJECT,
        ("3+X",),
        related_to=("one-on-one",),
        note="one-on-one-3-plus-x;NFKC/casefold 后命中 3+x",
    ),
    Concept(
        "works",
        ConceptKind.OBJECT,
        ("我的作品",),
        note="库内功能名;classlearn-spoken-island-entry 入口场景",
    ),
    Concept(
        "learning-data",
        ConceptKind.OBJECT,
        ("学情数据", "学情"),
        related_to=("report",),
        note="学情数据 ≠ 学情报告;learning-data-sharing-switch;「学情」F 二轮补,"
        "「学情报告」最长匹配优先归 report,不冲突",
    ),
    Concept(
        "digital-currency",
        ConceptKind.OBJECT,
        ("数字货币",),
        note="shenzhen-digital-currency-protocol",
    ),
    Concept(
        "teacher-homepage",
        ConceptKind.OBJECT,
        ("教师主页", "老师主页"),
        note="teacher-profile-page、teacher-praise-wall",
    ),
    Concept(
        "calendar",
        ConceptKind.OBJECT,
        ("日历", "日历页"),
        note="通用度中,教育语境接受;self-study-course-rules 区分词",
    ),
    Concept(
        "study-task",
        ConceptKind.OBJECT,
        ("学习任务", "任务按钮"),
        note="harmony-phase1-learning-task-mask",
    ),
    Concept("notice", ConceptKind.OBJECT, ("购课须知",), note="course-notice-confirmation"),
    # F 二轮补充(消融 F 后剩余 challenge 归因,2026-09-28):
    Concept(
        "personalization",
        ConceptKind.OBJECT,
        ("个性化推荐",),
        note="learning-data-sharing-switch alias 锚点",
    ),
    Concept(
        "phone",
        ConceptKind.OBJECT,
        ("手机号", "手机号码"),
        note="login-registration-basics;库外「手机号」场景有碰撞面,负例验证通过",
    ),
    Concept(
        "materials",
        ConceptKind.OBJECT,
        ("资料页", "课程资料"),
        note="class-notes-in-materials;不补「笔记」(「笔记本电脑」子串碰撞)",
    ),
    Concept(
        "promotion",
        ConceptKind.OBJECT,
        ("优惠活动", "促销活动", "联报"),
        note="promotion-coupon-rules summary 锚点;「优惠」「活动」单字不补",
    ),
    Concept(
        "teaching-point",
        ConceptKind.OBJECT,
        ("教学点",),
        note="class-location-display、nearby-teaching-point-filter 双条目锚点",
    ),
    Concept(
        "nearby",
        ConceptKind.FACET,
        ("附近",),
        note="位置限定,需与条目共享明确业务场景才可召回",
    ),
    Concept(
        "full-care",
        ConceptKind.OBJECT,
        ("全托", "全托课", "全托包"),
        related_to=("one-on-one",),
        note="one-on-one-full-care-package alias 锚点",
    ),
    Concept(
        "online-offline",
        ConceptKind.OBJECT,
        ("面授", "网课"),
        note="online-lesson-in-offline-class",
    ),
    Concept(
        "resource-slot",
        ConceptKind.OBJECT,
        ("资源位",),
        note="资源投放对象;弹窗仅表示界面形态",
    ),
    Concept(
        "verification-code",
        ConceptKind.OBJECT,
        ("验证码",),
        note="库外 App 也会问,但库内有条目(login-registration-basics),接受",
    ),
    Concept("schedule", ConceptKind.OBJECT, ("课表",), note="通用度中;class-reschedule-cascade"),
    Concept(
        "answer",
        ConceptKind.OBJECT,
        ("答案", "答案解析"),
        related_to=("handout",),
        note="讲义答案场景;handout-answer-not-shown",
    ),
    Concept(
        "region",
        ConceptKind.FACET,
        ("地区", "区域"),
        note="地点限定;港澳台使用各自 region 值,不当作等价对象",
    ),
    Concept(
        "sensitive-word",
        ConceptKind.OBJECT,
        ("敏感词", "内容风险", "潜在风险"),
        note="appraise-sensitive-word-block",
    ),
    # F 阶段审核新增意图短语(§3):通用语义的精确问法,整句命中才召回,
    # 比把「老师」「提醒」「弹窗」补成 OBJECT 安全。
    Concept(
        "search-teacher-intent",
        ConceptKind.INTENT,
        ("搜不到老师",),
        note="保留带对象的短语;泛搜索失败移入 STATE",
    ),
    Concept(
        "message-missed-intent",
        ConceptKind.INTENT,
        ("没收到提醒", "上课提醒没收到"),
        note="message-types-catalog;「提醒」太通用,不补 OBJECT",
    ),
    Concept(
        "bridge-native-intent",
        ConceptKind.INTENT,
        ("调起原生录音", "h5调用原生", "h5 调用原生", "h5调原生失败", "h5 调原生失败"),
        note="classlearn-h5-bridge-contract;保留现有条目中 H5 后有空格的写法;"
        "handler 是编程通用词,不补",
    ),
    Concept(
        "popup-missed-intent",
        ConceptKind.STATE,
        ("弹窗不显示了", "首页活动没了"),
        note="通用现象不独立召回,由 popup 限定与业务场景共同判断",
    ),
    Concept("popup", ConceptKind.FACET, ("弹窗",), note="界面形态,不是资源位的同义词"),
    Concept("meeting-tool", ConceptKind.FACET, ("腾讯会议",), note="上课工具,不是课程对象"),
    Concept("generic-search-failure", ConceptKind.STATE, ("搜索不出来", "搜不到结果")),
    Concept(
        "quota",
        ConceptKind.OBJECT,
        ("名额", "满员", "超员", "超限额", "班级满了"),
        note="班级名额对象(class-quota-and-over-quota);「班级满了」F 审核补,单字「满了」不补",
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
# 只收驼峰完整标识符;「H5」「handler」「native」单 token 通用度太高,不收录。
REGISTERED_SYMBOLS: tuple[str, ...] = (
    "evaluationCheckView",
    "fromTask",
    "isNative",
    "JSBridge",
    "lessonType",
    "liveType",
)

# 数量/单位/角色白名单(文档 5.2.6):只转换登记过的等价,不全局替换数字。
UNIT_FACETS: tuple[tuple[tuple[str, ...], tuple[str, str]], ...] = (
    (("五公里", "5公里", "5km", "5KM"), ("distance", "5km")),
    (("顾问",), ("role", "advisor")),
    (("家长",), ("role", "parent")),
    (("香港",), ("region", "hong-kong")),
    (("澳门",), ("region", "macao")),
    (("台湾",), ("region", "taiwan")),
    (("pdf",), ("file_media", "pdf")),
    (("图片", "照片", "jpg", "jpeg", "png"), ("file_media", "image")),
)

_ASCII_TOKEN_RE = re.compile(r"[A-Za-z0-9]+(?:[._:/#@-]+[A-Za-z0-9]+)+|[A-Za-z0-9]+")


def _term_spans(text: str, term: str):
    """字面连续匹配;Latin 词不能从另一个标识符或路径内部切出。"""
    ascii_spans = (
        [match.span() for match in _ASCII_TOKEN_RE.finditer(text)]
        if term[0].isascii() or term[-1].isascii()
        else []
    )
    start = 0
    while (index := text.find(term, start)) >= 0:
        end = index + len(term)
        if not any(a < index < b or a < end < b for a, b in ascii_spans):
            yield index, end
        start = index + 1


def extract_facets(text: str) -> frozenset[tuple[str, str]]:
    """不跨边界拼接单位/限定词;角色和地域不进入业务对象分母。"""
    normalized = normalize_human_text(text)
    found: set[tuple[str, str]] = set()
    for variants, facet in UNIT_FACETS:
        for variant in variants:
            if any(_term_spans(normalized, normalize_human_text(variant))):
                found.add(facet)
    # 限定词即使与长意图短语重叠也保留;但不增加对象数量。
    for term, concept in _TERM_INDEX:
        if concept.kind is ConceptKind.FACET and any(_term_spans(normalized, term)):
            found.add(("topic", concept.concept_id))
    return frozenset(found)


TRANSFER_ACTIONS = frozenset({"transfer-in", "transfer-out"})


def transfer_context(text: str) -> frozenset[str]:
    """文件输入/输出与介质限定;可用于同对象排序,不能用作召回锚点。

    单独抽取以保留「错题录入」对象内部的录入动作,不受最长对象匹配遮蔽。
    不解析否定或文件支持关系,匹配仅表示该条目谈到了查询涉及的任务/格式。
    """
    normalized = normalize_human_text(text)
    actions = {
        concept.concept_id
        for term, concept in _TERM_INDEX
        if concept.concept_id in TRANSFER_ACTIONS and any(_term_spans(normalized, term))
    }
    media = {
        f"file_media:{value}" for kind, value in extract_facets(normalized) if kind == "file_media"
    }
    return frozenset(actions | media)


# 预编译:term -> concept,按 term 长度降序实现最长匹配优先(文档 5.2.5)。
_TERM_INDEX: list[tuple[str, Concept]] = sorted(
    (
        (unicodedata.normalize("NFKC", term).casefold(), concept)
        for concept in CONCEPT_REGISTRY
        for term in concept.terms
    ),
    key=lambda item: (-len(item[0]), item[0], item[1].concept_id),
)

# 保留技术片段内部的 ._/:#@-+, 以便边界检查识别 foo_xnote 与 libnative.so。
_PUNCT_BOUNDARY_RE = re.compile(r"[\s,。!?、;~·—()\"'“”【】\[\]（）]+")

# 场景来自查询与条目实际文本,不从业务域/目录或来源权威推断。
# 只有双方共享场景时,附近/弹窗/地域等弱限定才能提供候选。
CONTEXT_CUES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("registration", ("注册", "添加学生", "添加学员")),
    ("course", ("课程", "班级", "教学点", "选课", "课时", "上课", "购课")),
    ("learning", ("课堂", "讲义", "学习", "学情")),
)


def contexts_in(text: str) -> frozenset[str]:
    normalized = normalize_human_text(text)
    return frozenset(
        context
        for context, terms in CONTEXT_CUES
        if any(any(_term_spans(normalized, term)) for term in terms)
    )


# 外部主体词表:只用于零命中时的「项目外」软提示(reason code),不参与资格、排序或排除。
# 刻意不收:微信(常作 H5 环境而非主体)、腾讯会议(已登记为小灶课上课工具 FACET)、
# 学校/高考(教育邻近词,误提示风险高)。词表变化进入 rules_digest。
EXTERNAL_SUBJECT_TERMS: tuple[str, ...] = (
    "淘宝",
    "天猫",
    "京东",
    "拼多多",
    "银行",
    "酒店",
    "宾馆",
    "王者荣耀",
    "b站",
    "哔哩哔哩",
    "抖音",
    "小红书",
    "百度",
    "github",
    "windows",
    "打印机",
    "冰箱",
    "路由器",
    "耳机",
    "记事本",
    "劳动合同",
)


def external_subject_hint(text: str) -> bool:
    """查询含已登记外部主体词;边界感知,标识符/路径内部的片段不算。

    命中不证明问题在库外(外部词可作环境/对照),只允许作为零命中时的提示。
    """
    normalized = normalize_human_text(text)
    return any(
        any(_term_spans(normalized, term)) for term in EXTERNAL_SUBJECT_TERMS
    )


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
    contexts: frozenset[str] = frozenset()
    generic_only: bool = False  # 去空白后只剩套话/通用症状/平台词
    matched_spans: tuple[tuple[int, int], ...] = ()  # normalized_text 中的区间,非原文偏移


def analyze_query(query: str, *, canonical_ids: Collection[str] = ()) -> QueryFeatures:
    """特征抽取:先完整技术片段,再在人类语言片段上做最长词表匹配(文档 5.2 边界)。

    不做自然语言解析;重叠区间按区间长度降序、起点升序、概念 ID 字典序确定性选择。
    """
    nfkc = unicodedata.normalize("NFKC", query)
    symbols = {
        match.group()
        for match in _ASCII_TOKEN_RE.finditer(nfkc)
        if match.group() in REGISTERED_SYMBOLS or match.group() in canonical_ids
    }
    normalized = normalize_human_text(query)
    facets = extract_facets(normalized)

    hits: list[tuple[int, int, Concept]] = []  # (start, end, concept) 区间不重叠
    occupied = [False] * len(normalized)
    for term, concept in _TERM_INDEX:
        for index, end in _term_spans(normalized, term):
            if not any(occupied[index:end]):
                hits.append((index, end, concept))
                for position in range(index, end):
                    occupied[position] = True

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
    actions.update(transfer_context(normalized) & TRANSFER_ACTIONS)
    scaffolded = QUESTION_SCAFFOLD_RE.sub("", normalized)
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
        facets=facets,
        contexts=contexts_in(normalized),
        generic_only=generic_only,
        matched_spans=tuple(sorted((start, end) for start, end, _ in hits)),
    )


def analyze_entry_text(text: str) -> frozenset[str]:
    """条目侧词表抽取:返回命中的概念 ID 全集(含 RELATED,关联声明用)。"""
    normalized = normalize_human_text(text)
    found: set[str] = set()
    for term, concept in _TERM_INDEX:
        if any(_term_spans(normalized, term)):
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
        json.dumps(
            {
                "concepts": payload,
                "symbols": REGISTERED_SYMBOLS,
                "facets": UNIT_FACETS,
                "transfer_actions": sorted(TRANSFER_ACTIONS),
                "contexts": CONTEXT_CUES,
                "external_subjects": EXTERNAL_SUBJECT_TERMS,
                "normalizer": "boundary-v2",
                "punctuation": _PUNCT_BOUNDARY_RE.pattern,
                "ascii_tokens": _ASCII_TOKEN_RE.pattern,
                "scaffold": QUESTION_SCAFFOLD_RE.pattern,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
