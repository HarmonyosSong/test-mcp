from __future__ import annotations

import re
from pathlib import Path

from fastmcp import Client
from harmony_repo_mcp import create_mcp_server

from ..domain import (
    DiagnosisCase,
    DiagnosisReport,
    Evidence,
    EvidenceKind,
    RootCauseCandidate,
    Severity,
    ToolEvent,
    Verdict,
)

PATH_PATTERN = re.compile(r"([\w./-]+\.(?:ets|ts|js|json5|json|cpp|cc|c|h))(?::(\d+))?")
ERROR_PATTERN = re.compile(
    r"(?:TypeError|ReferenceError|SyntaxError|Exception|Error|failed|denied|crash|白屏|无响应)",
    re.IGNORECASE,
)


def collect_input_evidence(case: DiagnosisCase) -> list[Evidence]:
    evidence: list[Evidence] = []
    text = "\n".join(part for part in (case.description, case.input_evidence) if part)
    for index, line in enumerate(text.splitlines(), start=1):
        if not ERROR_PATTERN.search(line) and not PATH_PATTERN.search(line):
            continue
        kind = EvidenceKind.LOG if case.input_evidence else EvidenceKind.USER
        path_match = PATH_PATTERN.search(line)
        location = None
        if path_match:
            location = path_match.group(1)
            if path_match.group(2):
                location = f"{location}:{path_match.group(2)}"
        evidence.append(
            Evidence(
                kind=kind,
                source="pasted-evidence" if case.input_evidence else "issue-description",
                location=location or f"line {index}",
                excerpt=line.strip()[:800],
                supports="输入中出现可复核的异常或源码位置线索",
            )
        )
        if len(evidence) >= 12:
            break
    return evidence


def category_for(text: str) -> str:
    lowered = text.casefold()
    if any(token in lowered for token in ("permission", "denied", "权限", "module.json5")):
        return "权限或模块配置"
    if any(token in lowered for token in ("hvigor", "build", "compile", "编译", "构建")):
        return "构建或依赖配置"
    if any(token in lowered for token in ("typeerror", "exception", "crash", "崩溃")):
        return "ArkTS 运行时异常"
    if any(token in lowered for token in ("router", "navigation", "页面", "白屏", "arkui")):
        return "ArkUI 页面或路由"
    if any(token in lowered for token in ("resource", "资源", "$r(")):
        return "资源引用"
    return "待分类"


def build_demo_report(case: DiagnosisCase, evidence: list[Evidence]) -> DiagnosisReport:
    text = "\n".join((case.title, case.description, case.input_evidence))
    category = category_for(text)
    locations = [item.location for item in evidence if item.location and "." in item.location]
    candidates: list[RootCauseCandidate] = []

    observed_input = [
        item for item in evidence if item.source in {"pasted-evidence", "issue-description"}
    ]
    if observed_input:
        title, explanation = _candidate_for(text, category)
        candidates.append(
            RootCauseCandidate(
                title=title,
                explanation=explanation,
                confidence=0.74 if locations else 0.58,
                evidence_ids=[item.id for item in observed_input[:3]],
            )
        )

    if not observed_input:
        return DiagnosisReport(
            verdict=Verdict.INSUFFICIENT_EVIDENCE,
            severity=Severity.UNKNOWN,
            summary="当前只有问题现象，尚不足以形成可验证的根因判断。",
            issue_category=category,
            evidence=evidence,
            missing_information=[
                "触发问题时的完整错误日志或异常堆栈",
                "最小复现步骤、预期结果与实际结果",
                "相关模块、页面、源码文件或工程路径",
            ],
            checks_performed=[
                "已结构化问题描述",
                "已检查输入中的错误标识和文件位置",
                "已加载仓库业务上下文，但未将业务文档当作故障证据",
            ],
            limitations=_static_limitations(),
            confidence=0.18,
        )

    verdict = Verdict.PROBABLE
    confidence = candidates[0].confidence
    return DiagnosisReport(
        verdict=verdict,
        severity=_severity_for(text),
        summary=f"输入证据指向{category}，首要候选为“{candidates[0].title}”。",
        issue_category=category,
        likely_location=locations[0] if locations else None,
        root_cause_candidates=candidates,
        evidence=evidence,
        ruled_out=[],
        missing_information=["需在目标环境复现并补充同一时间窗口的完整日志以确认根因"],
        checks_performed=[
            "提取异常关键字、文件路径和行号",
            "按 HarmonyOS 问题类别归类",
            "校验候选原因是否关联输入证据",
        ],
        limitations=_static_limitations(),
        confidence=confidence,
    )


def _candidate_for(text: str, category: str) -> tuple[str, str]:
    lowered = text.casefold()
    if "cannot read" in lowered or "undefined" in lowered or "typeerror" in lowered:
        return (
            "未定义值在使用前缺少有效性判断",
            "异常类型与文本通常对应 ArkTS 对 undefined/null 对象的属性访问；"
            "需以引用位置上下文确认。",
        )
    if "permission" in lowered or "denied" in lowered or "权限" in lowered:
        return (
            "权限声明、授权状态或调用时机不一致",
            "输入中出现权限拒绝信号，应对照 module.json5 声明和运行时授权分支验证。",
        )
    if "白屏" in lowered or "blank" in lowered:
        return (
            "页面初始化或首帧渲染链路被异常中断",
            "白屏与错误线索共同指向页面构建、路由目标或初始化数据链路，尚需源码上下文确认。",
        )
    if "无响应" in lowered or "click" in lowered or "点击" in lowered:
        return (
            "交互事件未进入有效处理分支",
            "点击无响应通常需要核对事件绑定、禁用态和状态更新；当前候选仅由输入证据支持。",
        )
    return (
        f"{category}中的输入异常线索",
        "候选由用户提供的异常行和位置提取，必须结合命中源码上下文继续验证。",
    )


def _severity_for(text: str) -> Severity:
    lowered = text.casefold()
    if any(token in lowered for token in ("crash", "fatal", "崩溃")):
        return Severity.HIGH
    if any(token in lowered for token in ("白屏", "failed", "exception", "error")):
        return Severity.MEDIUM
    return Severity.LOW


def _static_limitations() -> list[str]:
    return [
        "仅执行静态、只读诊断，未编译、运行或连接设备",
        "未调用 DevEco CLI，也未修改任何项目文件",
        "Demo 模式使用确定性规则；配置 model 模式后由 PydanticAI 生成结构化报告",
    ]


async def inspect_workspace(
    case: DiagnosisCase, evidence: list[Evidence]
) -> tuple[list[Evidence], list[str], list[ToolEvent]]:
    if not case.workspace_path:
        return evidence, [], []
    search_terms = _search_terms(case)
    checked: list[str] = []
    events: list[ToolEvent] = []
    server = create_mcp_server(Path(case.workspace_path))
    async with Client(server) as client:
        issue_query = "\n".join((case.title, case.description, case.input_evidence))
        context_result = await client.call_tool(
            "load_business_context",
            {"query": issue_query, "limit": 5},
        )
        contexts = _tool_items(context_result.data)
        checked.append(f"通过 MCP 加载 {len(contexts)} 份仓库业务上下文")
        events.append(
            ToolEvent(
                tool="load_business_context",
                status="completed",
                summary=f"加载 {len(contexts)} 份相关 Skill、合同或模块参考",
            )
        )
        for context in contexts[:3]:
            evidence.append(
                Evidence(
                    kind=EvidenceKind.CONFIG,
                    source="mcp:load_business_context",
                    location=context["path"],
                    excerpt=context["excerpt"][:800],
                    supports="仓库内业务契约或模块参考与当前问题相关",
                )
            )
        for term in search_terms[:3]:
            result = await client.call_tool(
                "search_project_text",
                {"query": term, "file_glob": "**/*", "limit": 5},
            )
            matches = _tool_items(result.data)
            checked.append(f"通过 MCP 搜索“{term}”，命中 {len(matches)} 处")
            events.append(
                ToolEvent(
                    tool="search_project_text",
                    status="completed",
                    summary=f"搜索“{term}”，命中 {len(matches)} 处",
                )
            )
            for match in matches:
                evidence.append(
                    Evidence(
                        kind=EvidenceKind.SOURCE,
                        source="mcp:search_project_text",
                        location=f"{match['path']}:{match['line']}",
                        excerpt=match["excerpt"],
                        supports=f"源码中命中输入线索“{term}”",
                    )
                )
                if len(evidence) >= 20:
                    return evidence, checked, events
    return evidence, checked, events


def _search_terms(case: DiagnosisCase) -> list[str]:
    text = "\n".join((case.description, case.input_evidence))
    paths = [match.group(1).split("/")[-1] for match in PATH_PATTERN.finditer(text)]
    error_words = re.findall(r"\b(?:[A-Z]\w*(?:Error|Exception)|[A-Z]{2,}-?\d{3,})\b", text)
    domain_terms = [
        term
        for term in ("订单", "支付", "退款", "合同", "购物车", "课程", "学生", "登录")
        if term in text
    ]
    return list(dict.fromkeys(paths + error_words + domain_terms))[:6]


def _tool_items(data: object) -> list[dict[str, object]]:
    if not isinstance(data, list):
        return []
    items: list[dict[str, object]] = []
    for item in data:
        if isinstance(item, dict):
            items.append(item)
            continue
        model_dump = getattr(item, "model_dump", None)
        if callable(model_dump):
            dumped = model_dump()
            if isinstance(dumped, dict):
                items.append(dumped)
                continue
        attributes = getattr(item, "__dict__", None)
        if isinstance(attributes, dict):
            items.append(
                {key: value for key, value in attributes.items() if not key.startswith("_")}
            )
    return items
