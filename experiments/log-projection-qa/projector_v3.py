"""投影器 v2：格式转换 + 结构去重（公共字段提升、stack 去重引用）。
对比：raw JSON / 朴素 MD 表格 / 提升版 MD。fixture 同 v1（对齐 106K 真实规模）。
"""
import json
import random
import string

random.seed(42)

CJK = "支付过程中出现问题收银台加载失败用户点击无响应页面白屏网络请求超时错误码"
STACK_FRAME = "at doTrade (https://cloudlearn-h5.speiyou.com/chunk-vendors.8f3a2b.js:12:3456) -> at async pay (index.js:88:21)\n"


def make_entry(i: int) -> dict:
    return {
        "appid": f"log-eagle-{random.randint(1, 20):04d}-prod",
        "clickid": random.choice(["invokeJsBridge", "studentSetUserInfo", "doTrade", "pageView", "payResult"]),
        "core": random.choice(["0", "1"]),
        "currenthref": f"https://cloudlearn-h5.speiyou.com/english/library?bookId={random.randint(10000, 99999)}&source=task",
        "cardId": "165010784572",
        "uid": "2592373",
        "deviceId": "TAL260609992D9E7192FC97A3FA9B1715AECD31",
        "osVersion": "OpenHarmony-7.0.0.111",
        "appVersion": "7.106.0",
        "ts": f"2026-11-19 10:{random.randint(0, 59):02d}:{random.randint(0, 59):02d}.{random.randint(100, 999)}",
        "level": random.choice(["INFO", "WARN", "ERROR"]),
        "traceId": "".join(random.choices(string.hexdigits.lower(), k=32)),
        "msg": "".join(random.choices(CJK, k=random.randint(8, 30))) + f" code={random.randint(100, 599)}",
        "stack": (STACK_FRAME * random.randint(2, 6))[:600],
        "networkType": random.choice(["wifi", "4g", "5g"]),
        "durationMs": str(random.randint(12, 3800)),
        "pageName": random.choice(["CashierPage", "LibraryPage", "TaskListPage"]),
        "eventId": f"evt_{random.randint(100000, 999999)}",
    }


def make_result() -> dict:
    cloud_results = []
    for t in range(20):
        logs = [make_entry(i) for i in range(5)]
        cloud_results.append({
            "source": "cloud", "vendor": "aliyun", "account": "1743276692096170",
            "collection": "pysy-front-log", "topic": f"prod-topic-{t}", "region": "cn-beijing",
            "total": len(logs), "logs": logs,
        })
    logcenter_results = []
    for s in range(8):
        logs = [make_entry(i) for i in range(6)]
        logcenter_results.append({"service": f"pay-trade-{s}", "total": len(logs), "logs": logs})
    return {
        "logcenter": {"scanned_services": 32, "matched_services": 8, "results": logcenter_results, "elapsed_ms": 812},
        "cloud": {"scanned_topics": 20, "matched_topics": 20, "results": cloud_results, "elapsed_ms": 1450},
        "partial_failures": [],
        "truncated": {"services_skipped": 2, "topics_skipped": 0, "logs_omitted": {"cloud": 37}},
    }


def cell(value) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\r\n", "⏎").replace("\n", "⏎")


def group_to_md_v2(title: str, logs: list[dict], max_cols: int = 10) -> list[str]:
    """提升版：组内恒等字段提升到头部；stack 去重编号；表只放变化列。"""
    lines = [f"## {title}（{len(logs)} 条）"]
    if not logs:
        lines.append("（无日志）")
        return lines
    # 恒等字段：组内所有行同值 → 提升
    common: dict[str, str] = {}
    keys = set().union(*[set(r) for r in logs])
    for k in sorted(keys):
        values = {str(r.get(k, "")) for r in logs}
        if len(values) == 1:
            common[k] = values.pop()
    if common:
        lines.append("公共：" + "; ".join(f"{k}={cell(v)}" for k, v in common.items()))
    # stack 去重
    stacks: dict[str, str] = {}
    for r in logs:
        st = str(r.get("stack", ""))
        if st and st not in stacks:
            stacks[st] = f"S{len(stacks) + 1}"
    # 诊断关键字段永远保留为列（按此优先级排头），其余恒等字段提升、非常量字段全保留；
    # 不做频率截断——静默丢列会让模型去"推断"缺失字段，质量退化在统计里不可见。
    PRIORITY = ["ts", "level", "clickid", "msg", "traceId", "service", "topic"]
    varying_keys = [k for k in keys if k not in common and k != "stack"]
    cols = [k for k in PRIORITY if k in varying_keys] + sorted(k for k in varying_keys if k not in PRIORITY)
    use_stack = any("stack" in r for r in logs)
    header = cols + (["stack"] if use_stack else [])
    lines += ["", "| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for r in logs:
        row = [cell(r.get(c, "")) for c in cols]
        if use_stack:
            row.append(stacks.get(str(r.get("stack", "")), "—"))
        lines.append("| " + " | ".join(row) + " |")
    if stacks:
        lines.append("")
        for text, sid in stacks.items():
            lines.append(f"[{sid}] {cell(text)}")
    return lines


def group_to_md_v1(title: str, logs: list[dict], max_cols: int = 10) -> list[str]:
    lines = [f"## {title}（{len(logs)} 条）", ""]
    if not logs:
        lines.append("（无日志）")
        return lines
    freq: dict[str, int] = {}
    for row in logs:
        for k in row:
            freq[k] = freq.get(k, 0) + 1
    keys = sorted(freq, key=lambda k: -freq[k])
    cols, extra = keys[:max_cols], keys[max_cols:]
    lines.append("| " + " | ".join(cols) + " |")
    lines.append("|" + "---|" * len(cols))
    for row in logs:
        lines.append("| " + " | ".join(cell(row.get(c, "")) for c in cols) + " |")
        if extra:
            rest = {k: row[k] for k in extra if k in row}
            if rest:
                lines.append("  ↳ " + "; ".join(f"{k}={cell(v)}" for k, v in rest.items()))
    return lines


def project(result: dict, group_fn) -> str:
    out: list[str] = []
    lc = result.get("logcenter") or {}
    cloud = result.get("cloud") or {}
    out.append("# 日志检索结果")
    out.append(f"- 日志中心：扫描 {lc.get('scanned_services', 0)} 服务，命中 {lc.get('matched_services', 0)}")
    out.append(f"- 云日志：扫描 {cloud.get('scanned_topics', 0)} topic，命中 {cloud.get('matched_topics', 0)}")
    for side, groups in (("日志中心", lc.get("results") or []), ("云日志", cloud.get("results") or [])):
        for g in groups:
            name = g.get("service") or g.get("topic") or "unknown"
            out += [""] + group_fn(f"{side} {name}", g.get("logs") or [])
    tr = result.get("truncated") or {}
    notes = [f"{k}={v}" for k, v in tr.items() if v]
    if notes:
        out += ["", "> 截断说明：" + "；".join(notes) + "。要更多条目可用 page/per_service_size 参数窄取。"]
    return "\n".join(out)


if __name__ == "__main__":
    result = make_result()
    raw = json.dumps(result, ensure_ascii=False)
    md1 = project(result, group_to_md_v1)
    md2 = project(result, group_to_md_v2)
    print(f"JSON          : {len(raw):>7} 字符")
    print(f"朴素 MD       : {len(md1):>7} 字符  ({len(md1)/len(raw):.1%})")
    print(f"提升版 MD     : {len(md2):>7} 字符  ({len(md2)/len(raw):.1%})")
    with open("/tmp/log_projection_v3.md", "w") as f:
        f.write(md2)
    print("\n--- 提升版样例（前 26 行）---")
    print("\n".join(md2.splitlines()[:26]))
