# 0002：Runtime、Skill 与知识检索的成本和证据约束

> 本 ADR 的策略仍生效；文中 Python Agent、`ToolFailed` 和旧评测命令是历史实现上下文。当前策略由 `runtime/src/diagnosis/agent.ts`、`runtime/src/diagnosis/evidence.ts` 和 Mastra tool wrappers 承载；当前实现见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。

2026-09-23。目标是在保持排查质量的前提下减少工具往返与重复上下文。
2026-09-24 修订：单次结构化诊断路径（HarmonyDiagnosisAgent / 四阶段案例队列）已移除，
统一为多轮对话单一路径；结构化报告经 `submit_diagnosis_report` 工具在对话中提交并接受同一套证据校验。

## 职责与入口

本节记录产品策略；当前 Mastra 运行时行为以 `runtime/src/diagnosis/agent.ts`、`runtime/src/diagnosis/evidence.ts` 和 `runtime/src/capabilities/session.ts` 为准，文中的 Python 命令只作为历史评测记录。

- Knowledge 保存术语、候选、区分判据、代码锚点与适用范围。
- Skill 按已有线索选择检索、读取、追问或结论，不把知识命中当作根因证明。
- Runtime 管理工具预算、复用、上下文配对、观测记录和结构化报告验证。
- 对话路径的入口规则：规则澄清默认 `lookup_issue`；故障定位按计划先完成 `observe` 现场观察，再进入 `source` 源码分析。知识提供规则、候选与导航，不替代日志或源码观测；明确技术锚点可缩小观察范围，但不跳过客户端阶段门禁。
  模型模式不再运行按泛业务词全仓搜索的预扫描。未配置模型（demo 模式）时聊天不可用。
- Skill 通过 metadata.modes 和 required_tools 声明模式和硬依赖；目录与加载工具使用同一过滤结果。
  动态源码上下文技能只描述平台、产品线、形态和版本的解析规则，不提供仓库或分支选择工具；
  报告技能要求 `submit_diagnosis_report`。
  Runtime 从提示词和已确认 LogCenter 事实读取 `version-registry/`，自动绑定登记的 ref 与固定 commit；
  用户不预选、不登记、不切换仓库。

## 工具与上下文

- `lookup_issue` 内部处理现象到事实的回退，返回候选摘要和有限预览，不递归展开整个知识图。
  预览缺少必要判据或例外时再分段读取正文；不得把截断部分当作不存在。
  `get_knowledge_entry` 使用 offset/limit（默认 2000、最多 4000 字符），next_offset 指示后续正文。
  search_knowledge 只用于精确二次查询，list_symptoms 只用于明确的覆盖盘点，不构成第二套默认入口。
- 相同工具和参数的成功只读调用在同一轮内只执行一次，后续返回简短复用提示。
  失败仍遵循已有瞬时错误重试规则；绑定新的源码快照时清除旧上下文的结果和签名，下一轮预算独立。已绑定会话不会在轮次中热切换快照。
- 默认每轮总调用 30 次、失败 10 次、连续无新增信息 4 次。空结果、重复结果和复用均参与无进展计数。
  限额可配置，到限停用工具，保留输出已有证据和最小缺口的能力。
- 每次模型请求前和历史持久化时使用同一裁剪逻辑：长工具结果明确截断，旧历史按完整用户轮次移除，
  留下有限的问答摘录。不能拆开工具调用与返回。当前轮完整性优先于消息数和字符数的软上限。
- load_skill 正文完整保留；lookup_issue 的有界预览和 get_knowledge_entry 正文页由工具控制大小，
  Runtime 不对它们二次截字符串，保留正文、游标、适用范围和截断标识。其他大结果仍按通用规则裁剪。
- 摘录是历史陈述和假设，不能自动提升为已验证事实；跨轮的结构化状态由 EvidenceLedger 快照承担
  （随会话持久化；容量与淘汰约定自 2026-09-29 起由 [0003](0003-evidence-ledger-lifecycle.md) 替代，
  原为「上限 120 条 FIFO 淘汰」），后续轮次的报告可引用早轮观测证据。
- 聊天失败、取消和重启恢复时保留该轮原始用户输入与未完成标记，不将半截工具调用或模型结论
  放入后续模型历史。流式输出的终态保存必须在取消保护下完成，避免遗留 streaming 阻塞会话。

## 证据约束

- Runtime 为实际源码读取、源码搜索结果和可追溯到用户输入的日志解析记录证据 ID 与原文。
- 用户输入始终保持 USER 来源，粘贴证据独立采集并使用自身行号；描述不能因为附带了
  其他材料而升级成 LOG，parse_hilog 也不能将问题描述重新登记成日志证据。
- 结构化报告通过 `submit_diagnosis_report` 工具提交；每个候选的引用必须存在，
  每个正向候选必须有本次观测到的源码或日志证据。
- 报告引用的 ID、类型、来源、位置和摘录必须与 Runtime 记录对应。模型可以说明证据支持什么，
  但不能自行创造原文或来源。知识与业务上下文不注册为本次故障的源码或日志证据。
- 校验失败会以 `ToolFailed` 返回可行动的修改要求，模型修正后重新提交；对话正文不输出报告草稿。
  这些校验保证结构和来源，不能自动证明因果推理正确。

## 验收与后续评估

离线回归覆盖入口无预扫描、协议配对、请求前裁剪、相同读取复用、预算停止、真实观测接受及伪造证据拒绝，
并以 Runtime 的 TypeScript 测试驱动真实工具链端到端验证报告提交与证据快照（`runtime/test/`）。
评估用例使用独立内容夹具，不能依赖生产知识库保留 mock 条目。
生产知识内容的召回另由 `agent/evals/test_knowledge_retrieval.py` 评测，覆盖已发现的回归措辞、
未原样加入 aliases 的额外改写和无关查询。内容变化需复核预期，不降低全局阈值来强行制造命中。
这个小型人工样本集不代表真实用户总体召回率，也不是盲测或真实模型端到端正确率。

**Python runtime 历史计量口径（2026-09）**：当时的 `tool_usage` 包含调用数、执行数、复用数、返回字符数、停止原因、模型请求数与运行耗时。此字段集合不是 Mastra 当前 API 的保证。

Mastra 当前记录工具 attempted/failed/accepted、budget、blocked、report attempts、复用及无进展计数；运行时消息提供模型返回的 input/output token usage（供应商未提供时为未知），并从 `step-start` 事件统计模型请求数、记录本轮耗时。固定集评测汇总运行时提供的 `model_requests` 与耗时；在模型调用前失败的轮次仍将请求数记为未知。聚合工具结果字符数没有统一计量口径，保持未知。未知值不得当作零。未配置或未执行真实模型评估时，不报告成本下降比例或诊断正确率提升。

后续使用固定模型和相同真实问题比较：正确定位率、无证据结论比例、合理追问/拒绝判断率、
模型轮数、总 Token、工具载荷、重复调用和耗时。成功与失败轮次都计入成本，不能靠提前放弃获得“节省”。

```bash
make test-runtime
make test-mcp
make knowledge-validate
```

旧 Python Agent/Server 测试命令属于本 ADR 形成时的历史验证入口，旧项目定义已退役，不再运行。以上为当前验证入口；当前实现边界见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。

## 2026-09-24 历史验证与反馈入口

- 当时的 `make live-eval` 运行固定的三场景四轮真实模型报告/追问评估，未配置模型时失败，不静默跳过。当前入口仍为 `make live-eval`，实现已切换为 Mastra TypeScript runner。
- `python -m harmony_agent.evaluation --input ... --baseline ...` 汇总及比较同模型、同数据集、同轮次结果。
  这条命令和 `harmony_agent.knowledge_feedback` 均属于旧 Python runtime，不能用于 Mastra 产物。当前案例操作使用 `npm --prefix runtime run cases -- <command>`；质量评测使用 `make live-eval`。
- 受控概念召回和现象覆盖只改善候选触达，不提升知识权威，也不改变观测账本或工具配对。
- 实际执行结果和适用边界见 [修复与验证说明](../triage-feedback-and-evaluation.md)。
