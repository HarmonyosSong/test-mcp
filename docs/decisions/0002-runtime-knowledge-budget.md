# 0002：Runtime、Skill 与知识检索的成本和证据约束

> 本 ADR 的策略仍生效；文中 Python Agent、`ToolFailed` 和旧评测命令是历史实现上下文。当前策略由 `runtime/src/diagnosis/agent.ts`、`runtime/src/diagnosis/evidence.ts` 和 Mastra tool wrappers 承载，剩余差异见 [`mastra-runtime-migration-spec.md`](../mastra-runtime-migration-spec.md)。

2026-09-23。目标是在保持排查质量的前提下减少工具往返与重复上下文。
2026-09-24 修订：单次结构化诊断路径（HarmonyDiagnosisAgent / 四阶段案例队列）已移除，
统一为多轮对话单一路径；结构化报告经 `submit_diagnosis_report` 工具在对话中提交并接受同一套证据校验。

## 职责与入口

- Knowledge 保存术语、候选、区分判据、代码锚点与适用范围。
- Skill 按已有线索选择检索、读取、追问或结论，不把知识命中当作根因证明。
- Runtime 管理工具预算、复用、上下文配对、观测记录和结构化报告验证。
- 对话路径的入口规则：业务描述默认 `lookup_issue`；明确技术锚点可直接查证据。
  模型模式不再运行按泛业务词全仓搜索的预扫描。未配置模型（demo 模式）时聊天不可用。
- Skill 通过 metadata.modes 和 required_tools 声明模式和硬依赖；目录与加载工具使用同一过滤结果。
  绑定技能要求 `bind_repository`；报告技能要求 `submit_diagnosis_report`，两者同属对话路径。
  绑定不承担检索路由，不预设仓库，已有仓库、分支与快照默认复用，用户明确要求时才切换。

## 工具与上下文

- `lookup_issue` 内部处理现象到事实的回退，返回候选摘要和有限预览，不递归展开整个知识图。
  预览缺少必要判据或例外时再分段读取正文；不得把截断部分当作不存在。
  `get_knowledge_entry` 使用 offset/limit（默认 2000、最多 4000 字符），next_offset 指示后续正文。
  search_knowledge 只用于精确二次查询，list_symptoms 只用于明确的覆盖盘点，不构成第二套默认入口。
- 相同工具和参数的成功只读调用在同一轮内只执行一次，后续返回简短复用提示。
  失败仍遵循已有瞬时错误重试规则；重新绑定仓库时清除旧上下文的结果和签名，下一轮预算独立。
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
并以脚本化模型驱动真实工具链端到端验证报告提交与证据快照（`agent/evals/test_diagnosis_regression.py`）。
评估用例使用独立内容夹具，不能依赖生产知识库保留 mock 条目。
生产知识内容的召回另由 `agent/evals/test_knowledge_retrieval.py` 评测，覆盖已发现的回归措辞、
未原样加入 aliases 的额外改写和无关查询。内容变化需复核预期，不降低全局阈值来强行制造命中。
这个小型人工样本集不代表真实用户总体召回率，也不是盲测或真实模型端到端正确率。

聊天轮（含 Agent 已返回失败事件的轮次）记录 `tool_usage`：调用数、执行数、复用数、返回字符数、
停止原因、模型请求数与 Agent 运行耗时（不含模型初始化和历史加载）。
请求数在 Runtime 请求入口计数，包含失败尝试，不包含供应商 SDK 内部的网络重试。
字符数用于观察载荷，不等于供应商计费 Token；实际输入/输出 Token 沿用模型 usage。
失败前的模型用量若供应商没有返回 usage，则保持未知；不得把未知成本当作零。
未配置或未执行真实模型评估时，不报告成本下降比例或诊断正确率提升。

后续使用固定模型和相同真实问题比较：正确定位率、无证据结论比例、合理追问/拒绝判断率、
模型轮数、总 Token、工具载荷、重复调用和耗时。成功与失败轮次都计入成本，不能靠提前放弃获得“节省”。

```bash
make knowledge-validate
uv run --project server pytest -q agent/tests agent/evals mcp_server/tests server/tests
```

上述 Python Agent/Server 测试命令是本 ADR 形成时的历史验证入口；目前不要用它们验收 Mastra runtime。当前 runtime 检查命令见根目录 `Makefile`，迁移验收状态见 [`mastra-runtime-migration-spec.md`](../mastra-runtime-migration-spec.md)。

## 2026-09-24 验证与反馈入口补充

- `make live-eval` 运行固定的三场景四轮真实模型报告/追问评估，未配置模型时失败，不静默跳过。
- `python -m harmony_agent.evaluation --input ... --baseline ...` 汇总及比较同模型、同数据集、同轮次结果。
  质量标签带 assessed/unassessed 分母，未知成本保留 null，失败轮次仍计入；自由文本无证据断言须另行复核。
- 聊天终态自动独立归档；`harmony_agent.knowledge_feedback` 提供复核、提案、校验入库与规范条目关联。
- 受控概念召回和现象覆盖只改善候选触达，不提升知识权威，也不改变观测账本或工具配对。
- 实际执行结果和适用边界见 [修复与验证说明](../triage-feedback-and-evaluation.md)。
