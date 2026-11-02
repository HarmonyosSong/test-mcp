"""Small, auditable business ontology; concept recall is a lead, never causal evidence.

Unlike lowering substring thresholds, equivalent phrases can have no shared characters.
This is bounded semantic expansion, not a claim of general embedding-based understanding.
"""

CONCEPTS: dict[str, tuple[str, ...]] = {
    "error-book": ("错题本", "错题集", "错题整理", "课中错题", "错题录入", "上传错题"),
    "combo-addon": ("组合加购", "搭配购课", "班课渗透", "加购", "买正课送体验课"),
    "cart": ("购课单", "购物车"),
    "contract": ("合同", "签约", "签字", "协议", "签署"),
    "handout": ("讲义", "讲议"),
    "replay": ("回放", "回看课程", "云听课"),
    "notes": ("课堂笔记", "课后笔记"),
    "invoice": ("发票", "开票"),
    "coupon": ("优惠券", "代金券", "有券", "叠券", "用券"),
    "trial": ("先学后付", "先满意再缴费", "先上课后付费", "体验后缴费"),
    "ai-assistant": ("小思ai", "蛋君"),
    "speech": ("语音评测", "口语岛", "朗读", "口语测评"),
    "picture-book": ("绘本", "分级阅读"),
    "appraisal": ("个人评价", "课程评价", "教师评价", "评论"),
    "one-on-one": ("1对1", "一对一"),
    "self-study": ("自学课", "自主学习课程"),
    "scan": ("扫一扫", "扫码", "扫描二维码"),
    "search": ("ai搜索", "智能搜索", "搜不到", "搜索不准"),
    "grade": ("投放年级", "年级显示", "课程年级"),
    "classroom": ("教室号", "具体教室"),
    "authorization": ("应用授权", "第三方授权", "xnote"),
    "face-login": ("免密登录", "人脸登录", "刷脸登录"),
    "programming": ("编程课堂", "编程课入口"),
    "report": ("学习报告", "学情报告"),
}


def concepts_in(text: str) -> set[str]:
    folded = text.casefold()
    return {name for name, terms in CONCEPTS.items() if any(term in folded for term in terms)}


def concept_score(query: str, terms: list[str]) -> tuple[float, str]:
    query_concepts = concepts_in(query)
    entry_concepts = concepts_in("\n".join(terms))
    shared = query_concepts & entry_concepts
    if not shared:
        return 0.0, ""
    # Never compete with a precise phrase. Multiple recognized concepts must overlap:
    # “错题本发票” must not appear to precisely identify either independent subject.
    score = (
        2.6 * len(shared) / len(query_concepts) * (0.8 + 0.2 * len(shared) / len(entry_concepts))
    )
    return score, "concept:" + ",".join(sorted(shared))
