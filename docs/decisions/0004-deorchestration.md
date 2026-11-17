# 0004: 去编排化——单 loop Agent + 工具封装 + 横切护栏

2026-11-17。本决策替代编排层方案（[orchestration-layer-design.md](../orchestration-layer-design.md)，
其确定性 Supervisor/分支/联合阶段已随本决策下线），并取代 [0003](0003-evidence-ledger-lifecycle.md)
中证据账本（EvidenceLedger）的容量淘汰与报告提交契约部分；0003 的 ev-ID 内容哈希契约继续有效。

## 背景

对标内部 compass（dev-agent）项目：单 Agent 单 loop，业务流程放 skills/ 指引文档，代码层只做
两件事——封装有用的工具 + 横切护栏。此前本项目的编排全部在 `runtime/`：三阶段管线
（local→source→joint）、确定性分流 Supervisor、observe→source 工具门禁、
submit_diagnosis_report 硬报告契约 + 650 行证据账本。这些编排把 Agent 的排查路径限制得过死，
且大量流程指引在 prompt 与 skills/ 之间重复漂移。

## 决策

1. **单 loop**：`runDiagnosisRound` 是唯一诊断路径（Web 与知音楼共用）。准入与持久化占位后，
   一次性 `agent.stream`（maxSteps=96），模型在护栏内自主完成
   知识检索 → 日志观察 → 源码取证 → 按需外部协查 → 最终回答。
2. **编排能力改为模型可见工具**：
   - `prepare_source`：按用户描述与已确认日志事实绑定只读源码快照；歧义/缺版本返回
     缺口说明文本（不抛错），模型决定追问或先查日志。源码工具组经懒代理挂载，
     未绑定返回提示（工具可用性即能力边界，替代硬门禁）。
   - `consult_compass`：委派统一外部全栈 Agent；固定摘要构造、轮次预算（4 次）、
     审计落库保留；返回标注「仅来自远端 Agent 报告，未验证」。
3. **横切护栏（RoundGuard）**：串行 dispatch、调用 120 次/失败 40 次硬上限、同签名失败
   禁原样重试（transient 一次）、可复用结果缓存（注册表存在性校验防陈旧）。连续无进展
   只注入提醒文本（硬阻断→软提醒，是本决策的核心差异）。软时限 900s 到期后工具一律
   返回收尾提示，180s 收尾窗后硬 abort 兜底。
4. **证据机制瘦身**：EvidenceLedger（容量淘汰/墓碑/excerpt 逐字校验）→ ObservationRegistry
   （append-only 元数据注册表，无正文存储、无淘汰，500 条软上限）。ev-ID 内容哈希契约
   不变（`ev-${sha256(pythonJson([name,args,location,text,sourceContext]))[:16]}`），
   兼容读取旧 `ledger_version=2` 快照。
5. **报告契约替换**：`submit_diagnosis_report` 退役。最终回答为自由文本，
   FinalAnswerValidator 校验四件机器可判的事：非空、无 DSML/工具协议泄露、引用的 ev-ID
   真实存在、含「判定：已定位|可能定位|证据不足|工具异常」锚点。打回重试 ≤2 次，
   仍不合格则放行并记 verdict=null。判定锚点让 diagnosis_outcome 日志、知音楼判定标签、
   eval 断言零迁移成本续命。

## 后果

- 正面：排查路径由模型自主决定，业务流程集中在 skills/ 单一位置；轮内可热绑定源码快照；
  代码量净减约 5000 行（编排层与账本删除）。
- 负面：无进展循环不再被硬阻断，依赖模型响应提醒文本（由 eval 观测）；最终回答的证据
  摘录真实性不再逐字校验（只校验 ID 存在性），依赖模型自律与评测。
- 知识案例归档格式变更：归档体为 steps + 注册表元数据 + messages_state（无 excerpt 正文）。
- 人工审批流（waiting_confirmation）退役：schema 保留枚举值供历史数据解析，
  启动修复一律按中断处理；ConsultationCard 只读渲染历史记录。
- Python 参考栈（`agent/`、`server/`）物理删除；生产链路自 Mastra 迁移以来一直在
  `runtime/`（TypeScript）。

## 验证

- runtime 321/321 测试绿；mcp_server pytest 绿；web 类型检查与测试绿。
- live eval 需在配置模型的环境重跑建立新基线（对照旧基线的 verdict/location 命中率）。
- 手动双渠道验收：Web 与知音楼各跑一个真实 incident 工单。
