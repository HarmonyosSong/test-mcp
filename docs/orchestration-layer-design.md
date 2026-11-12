# 编排层设计与实现：Supervisor、Agent Slot 与会话并发

> 状态：本文描述**当前已接入聊天链路的实现**。学员日志关联入账、提示词/日志上下文解析和精确快照选择器已接入框架；真实字段验收与正在运行轮次的源码热切换边界见 [multi-capability-expansion-plan.md](multi-capability-expansion-plan.md)。

## 1. 范围

### 1.1 已实现

1. **Runtime Supervisor**：确定性调查计划、客户端/服务端分支、自动跨侧、联合报告、预算与取消。
2. **Agent Slot Registry**：Compass 作为第一个 Slot，经 Registry 接入聊天诊断路径，支持 Agent Card、JSON-RPC SSE、自动协查、历史审批恢复和 CancelTask。
3. **多用户并发与会话隔离**：会话级互斥、全局并发闸门，以及历史等待审批记录的槽位释放和恢复轮次重新准入。
4. **客户端观察门禁**：`clientSteps` 持久化，`observe → source` 由工具层强制执行；服务端计划不携带客户端阶段。

### 1.2 当前边界

| 项目 | 当前说明 |
| --- | --- |
| 学员标识、设备/会话发现和 `observed_platform` | 私有上下文和有界发现框架已实现；生产 Catalog 尚未核实完整身份/平台字段 |
| 远程 SLS 日志证据化 | 目标绑定、身份匹配、脱敏和 `observation_context` 入账已实现；未关联条目不收录 |
| 平台/版本 → 固定源码快照 | 唯一映射、提示词/日志补齐上下文、后续轮次绑定和本地精确快照选择器已实现；正在运行轮次不热切换 |
| 多端知识库与端上下文完整产品化 | 仍需 Android/iOS 真实端到端验收 |
| 代码索引导航 | 由 Repository MCP 可选挂载，不属于 Supervisor 编排依赖；导航结果不能进入 EvidenceLedger |
| 多进程 lease/CAS | 未实现，只支持单进程准入 |

### 1.3 文档关系

- 当前模块与能力状态总览见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- Compass 传输与接入边界见 [../spec/compass-a2a-integration.md](../spec/compass-a2a-integration.md)。
- 日志四工具的现有契约与真实覆盖边界见 [../spec/log-catalog-query-capability.md](../spec/log-catalog-query-capability.md)。

## 2. 当前实现基线

- `runDiagnosisRound`（`runtime/src/diagnosis/run-round.ts`）：统一准备、Supervisor 分支、自动协查、历史审批暂停/恢复、联合阶段和终态持久化。
- 会话级防重入：Web 同会话并发返回 409；全局 `RunAdmission` 限制活跃轮次；IM 保留按用户排队语义。
- `createRoundCapabilitySession`（`capabilities/session.ts`）：按轮挂载知识/仓库/日志工具，统一取消与逆序清理，命名冲突拒绝整个挂载。
- `AgentSlotRegistry` + `CompassSlot`：真实 Compass 客户端已包装为远端槽位，由 Supervisor 调用；不是模型可直接绕过的自由工具。
- `EvidenceLedger`：会话级账本，按轮 restore/save；源码、可溯源 hilog 及通过目标/身份关联门禁的脱敏远程日志入账，每条远程日志携带 Runtime 控制的 `observation_context`。
- `ClientObservationGate`：绑定源码的客户端分支先观察再读源码；门禁拒绝不污染同参数源码调用的失败缓存。

## 3. 总体结构

```text
用户消息
  → POST /conversations/:id/messages
    → 会话准入（全局并发闸门 + 会话级互斥，§7）
    → persist user message + streaming placeholder（现有）
    → Supervisor.plan(...)                    生成 InvestigationPlan
      ├─ mode=local ──→ ClientBranch          DiagnosisAgent 与本地工具
      ├─ mode=server ──→ ServerBranch         ExternalConsultation → Slot
      └─ mode=parallel ─→ 两者并行            Supervisor 聚合
    → aggregate：本地事实 + external_findings → 联合报告（§4.5、§6.2）
      └─ 明确跨侧线索/缺口且预算充足 → 自动接续或有界 handoff（§4.4）
    → 终态落库 + SSE 完成事件
```

关键决策：

1. **Supervisor 是确定性编排代码，不是 Agent**。它不调用模型做分派；分流依据结构化输入（问题文本关键词、服务/环境、关联标识、会话端）加显式规则，`reason` 落库可审计。引入模型分流后置，需单独评审。
2. **客户端调查能力复用**：本地工具执行与证据校验保持同一入口；报告增加初步路由字段和联合阶段提示词（§4.5）。Supervisor 在分支外做 fan-out/fan-in 与自动接续。
3. **服务端分支=一次受控 Slot 调用**，使用持久化 `ExternalConsultation` 固定脱敏摘要和 digest，由 Runtime 自动授权并在同一轮执行；不允许模型绕过 Supervisor 直接调用叶子能力，也不要求老师审批。
4. **技术路由不让用户决策**：初始 `local` 发现跨侧线索后可自动接续 `server`，远端返回后自动聚合，必要时执行有界 handoff（§4.4）。IT 老师只描述问题和补充故障事实，不需要知道存在另一个 Agent。

## 4. Supervisor 设计

### 4.1 调查计划

```ts
type InvestigationPlan = {
  mode: 'local' | 'server' | 'parallel';
  branches: Array<'client' | 'server'>;
  remoteSlots: string[];              // 首版最多一个：'compass'
  clientSteps: Array<'observe' | 'source'>; // 客户端阶段；server 计划为空
  reason: string;                     // 分流理由，落库
  correlationReady: boolean;
  budget: { maxSeconds: number; maxRemoteCalls: number };
  maxHandoffRounds: number;           // 首版 1
};
```

生成规则（确定性，按序命中）：

1. 用户明确指定「只查客户端/服务端」→ 遵守，`reason` 记录来源为用户指定；指定服务端且远端可用时由 Runtime 自动协查，不增加用户操作。
2. 会话尚未绑定动态源码快照且无本地证据 → `local + clientSteps=['observe']`（知识、日志或澄清路径）；绑定固定源码快照的客户端计划为 `['observe','source']`。
3. 新工单即使命中服务端特征并带关联标识，只要尚无本地日志观测，仍先进入 `local`，不得直接并行或外发。
4. 已有本地日志观测，且问题文本命中服务端特征、关联标识齐全、Compass 可用 → `parallel`；关联标识缺失 → `local` 并在报告中列出缺口。
   - 「关联标识」首版指：traceId 或请求 ID、发生时间、报错接口/服务名。来源为提问上下文自带或用户在对话中补充；`correlationReady` 即「三者至少具备 traceId/请求 ID 之一」。
   - 「本地日志观测」指 EvidenceLedger 中已有的 `kind=log` 条目，源码观测或知识命中不能冒充。
5. 无足够信号 → `local`，但本地调查只是 loop 的起点，不是终点。本地报告经校验后若给出明确的跨侧路由，Supervisor 自动接续服务端调查；不要求用户理解或选择客户端/服务端。用户明确限定「只查客户端」时除外。

约束与边界：

- **特征词表是配置，不写死在代码里**：首版放 `runtime/contracts/server-signals.yaml`（服务名、接口前缀、错误码模式三组），按真实漏判/误判案例迭代；词表变更走评审，与知识库变更同级。
- **误分流的代价可控**：误判为 `parallel` 的最坏结果是多一次受预算约束的自动协查，客户端分支结果仍完整保留；误判为 `local` 则由 Agent 补充事实，或在发现明确跨侧线索后自动接续。首版宁可偏 `local`。
- `clientPlatform` 字段仍是 Plan 输入结构中的兼容字段，不参与分流。老师报告的系统只作 `reported_platform` 排序线索；只有关联到当前学员/设备/会话的日志或设备事实才能形成 `observed_platform`，不得把报告平台当硬过滤条件。源码版本选择由提示词和已保存的 LogCenter 事实完成。
- `unknown` 模式不落库为计划；信号不足即 `local`。

### 4.2 分支执行

```ts
interface BranchResult {
  branch: 'client' | 'server';
  status: 'completed' | 'failed' | 'cancelled' | 'skipped';
  // client：本地证据账本引用；server：独立的 RemoteConclusion
}

interface Branch {
  run(plan: InvestigationPlan, context: BranchContext): Promise<BranchResult>;
  cancel(reason: string): Promise<void>;
}
```

- **ClientBranch**：内部就是现有 `DiagnosisAgent.stream()` 封装；事件经学员隐私边界后传给 SSE 适配层。`clientSteps=['observe','source']` 时由 Runtime 工具门禁保证顺序：知识规则问答可直接结束，但源码读取/搜索必须先完成身份关联日志观察、粘贴 hilog 解析，或进入明确的观察降级。
- 观察阶段目录 `not_found/not_covered`、空结果、身份未匹配、查询失败或日志能力不可用允许降级，避免能力缺口锁死整轮；降级只开放有条件的源码观察，不代表平台已确认。目录 `ambiguous` 和仅执行 count 不会提前开放源码。门禁错误不污染同一源码调用的失败缓存，观察完成后可按原参数重试。
- **ServerBranch**：Runtime 为固定脱敏摘要建立自动授权记录后，由 Registry 调用 Slot；任务级 `CancelTask` 随轮次取消传播，没有面向老师的确认等待。
- 任一侧失败/cancelled 不影响另一侧已完成结果；Supervisor 汇总时保留各自状态。

### 4.3 聚合与预算

- 汇总输出 `joint_assessment` 与 `responsibility`（§4.5、§6.2）；仅服务端来源的主张必须标注「仅来自远端 Agent 报告」。
- 预算：`maxSeconds`（轮次总时长）、`maxRemoteCalls`（远端调用次数，含 handoff）。**执行机制**：Supervisor 在轮次开始时计算 `deadlineAt = now + maxSeconds`，派生轮次级 `AbortSignal`（剩余时间归零即触发）；到期时先对远端分支发 `CancelTask`，再让客户端分支用已有证据收尾并写明缺口。远端分支被预算中断时，已收到的部分结论必须标 `truncated: true` 并注明「因预算中断」，不得作为完整结论展示。
- handoff：任一侧的结构化结果发现明确跨侧线索或缺口，且预算未用完时，由 Supervisor 自动把补充问题交回对应分支；最多 `maxHandoffRounds` 次，不要求用户决定路由，不进入多轮 Agent 自由对话。

### 4.4 自动调查 Loop

使用者是 IT 老师，不应要求其理解客户端、服务端、Compass 或选择下一条技术路径。老师只需要描述现象、补充自己知道的故障事实；「接下来查哪一侧」和常规外部协查完全由 Supervisor 决定并自动执行。

```text
初始计划（local / server / parallel）
  → 分支执行与报告校验
  → 已有明确跨侧线索？
      ├─ 否 → 汇总并结束
      └─ 是 → Supervisor 自动创建下一阶段计划 / ExternalConsultation
              → Runtime 校验固定脱敏摘要并自动授权
              → 同一轮执行下一分支
              → 联合汇总；仍有明确缺口且预算足够时有界 handoff
```

这是 Runtime 控制的**有界状态流转**，不是两个 Agent 自由聊天。自动接续必须同时满足：

1. 触发依据是校验通过的结构化结果：`next_action.target=external` 和明确的下一步调查问题决定外部协查；`responsibility` 只表达当前证据的责任判断，不再兼任路由条件。Supervisor 不自行阅读自由文本猜测路由。
2. 故障诊断需要足够的本地观测和请求关联信息；关联信息可以来自本地日志，不必要求用户提供，不足时才向老师追问故障事实。`task_type=rule/implementation` 的项目内规则与实现查询在本地知识不足时可请求外部协查，不要求源码/日志观测或 traceId/requestId，也不据此推断服务端责任。
3. 全局预算、远端调用次数和 `maxHandoffRounds` 均未耗尽，远端槽位可用，且用户没有限定只查某一侧。
4. 外发内容只能是 Runtime 从当前用户问题生成的固定脱敏摘要，digest、附件空列表和 Slot 参数由代码校验；模型不能改写。自动调用不向老师展示技术审批，也不允许两个 Agent 自由互发。

本地初始计划升级为接续服务端调查时，当前计划更新为 `server`，`reason` 记录本地路由依据，初始计划和变更原因保留在 `investigation` 中。远端失败不会丢弃本地事实，loop 以已有结果和缺口说明收尾。

新请求的**暂停等待**只用于需要用户补充故障事实，不再用于常规外发授权。历史 `waiting_confirmation` 记录仍从已保存状态恢复，不重复已完成调查。**进入终态**的条件是：证据足以形成报告、分支失败或取消、预算或 handoff 上限耗尽；历史审批拒绝/过期也按原兼容逻辑收尾。进入终态时输出当前可得的完整报告和缺口，不为了 loop 而 loop。

### 4.5 聚合时序与联合报告生成

`joint_assessment` 是自然语言判断，确定性 Supervisor 生成不了；客户端分支提交报告时远端结论也可能尚未返回。因此报告分两阶段：

1. **本地报告阶段**：本地分支照常提交 `submit_diagnosis_report`，过现有账本校验，并输出 `task_type`、初步 `responsibility` 与独立的 `next_action`；`next_action.target=external` 才表示请求统一外部全栈 Agent，`responsibility` 不再充当路由开关。无需协查时到此结束；出现明确外部路由时，本地报告先保存，再由 §4.4 的 loop 自动接续，不要求用户重新发起。
2. **联合阶段**（存在服务端分支时）：远端结论到达（或调用失败/取消/超时）后，Supervisor 把 `RemoteConclusion` 作为**结构化输入**（不是自由文本、不进证据账本）追加给客户端分支的 Agent，由它在同一调查流程内生成 `joint_assessment`、更新 `responsibility` 并提交；扩展校验器在此刻校验 `verified_claims` 的引用（§6.2）。

自动接续时，本地报告属于中间分支结果，不直接触发整个调查流程的终态或 `RUN_FINISHED`；只有 loop 达到停止条件后才输出最终报告。提示词改动限定为两处：本地报告输出初步路由及依据；当 `external_findings` 存在时，说明其来源边界和引用规则。远端未归时 Agent 在本地报告中写明服务端缺口，`joint_assessment` 为 `null`。

## 5. Agent Slot Registry 落地

当前实现：

1. **`AgentSlotRegistry` 内存实现**：配置驱动的 Map，启动时从配置加载槽位（首版只有 `compass`）。`resolve` 校验槽位启用状态与开关；未启用即不存在。
2. **CompassSlotAdapter**：包装现有 `CompassA2AClient` 为 `RemoteAgentSlot` 契约——`invoke` 发送任务并消费 SSE 到终态，`cancel` 调 `CancelTask`，输出按 `maxOutputChars` 截断并标 `truncated`。
3. **远端可用性**：Registry 未配置或停用 Compass 槽位时，Supervisor 不生成含 `server` 分支的计划。历史 `consult_compass` 字段仅为旧数据保留，不再作为老师需要操作的会话开关。
4. **审计**：每次 `invoke`/`cancel` 落 `slot_audit` 字段（slotId、taskId、状态、耗时、截断标记），随会话持久化。

## 6. 证据账本在编排层的设计

### 6.1 所有权：账本只属于客户端分支

并行后有两条分支，但**账本只有一个，且只有客户端分支能写**：

| 分支 | 对 EvidenceLedger 的访问 | 产出归宿 |
| --- | --- | --- |
| ClientBranch | 读写：观测型工具经包装层 `capture()` 写入，按轮 `restore`/`save` | 本地证据（`evidence_refs`） |
| ServerBranch | **零接触**：不持有、不读写账本 | `external_findings`（RemoteConclusion） |
| Supervisor | 只读：聚合时读取证据快照用于汇总展示 | 不新增、不修改证据条目 |

Compass 等远端 Agent 返回的任何文本都不能经任何路径写入账本——没有「把外部结论登记为证据」的工具或 API，这不是提示词约束，是代码层不存在的路径。LogCenter 不是远端 Agent 结论通道；只有其目标已绑定且匹配当前身份的脱敏实际日志条目，才可经 Runtime 观察适配器入账。

### 6.2 联合报告的引用规则

| 报告字段 | 允许引用的 ID | 禁止 |
| --- | --- | --- |
| 本地事实 / 根因候选 | 本地 `evidence_refs`（源码、日志观测） | 引用 consultation、task、远端文本 |
| `external_findings` | `consultation_id` / `task_id` | 伪装成证据 ID 混入 `evidence_refs` |
| `joint_assessment.verified_claims` | 必须有本地证据支撑的主张 | 仅远端来源的主张进此列（应进 `unverified_claims` 并注明「仅来自远端 Agent 报告」） |

报告校验沿用现有账本校验入口，扩展校验器：发现 `verified_claims` 引用了不存在的本地证据 ID 或外部 ID 时拒绝提交，与非法报告同等处理（不静默降级）。本地证据既包括源码/日志观测，也包括账本注册的 `ev-user-*` 用户现场事实；但正向根因候选仍必须引用源码或日志观测，不能只靠用户描述。结构不是自由字符串数组，而是逐条绑定证据：

```json
{
  "responsibility": "server",
  "task_type": "incident",
  "externalScope": "frontend_backend",
  "next_action": {
    "target": "external",
    "question": "请统一外部全栈 Agent 核查该 requestId 对应请求的服务端失败原因"
  },
  "joint_assessment": {
    "relation": "corroborated",
    "text": "本地观测与远端结论的关系说明",
    "verified_claims": [
      { "claim": "有本地证据支撑的主张", "evidence_ids": ["ev-12345678"] }
    ],
    "unverified_claims": ["仅来自远端 Agent 报告的主张"],
    "next_actions": []
  }
}
```

本地阶段 `joint_assessment=null`；`next_action=null` 表示没有明确的后续调查问题。

### 6.3 时序：自动协查、历史恢复与补查

- 新协查：固定摘要和内部自动授权记录先落库，再执行远端；本地中间报告与账本保留，联合阶段在同一轮完成，不进入 `waiting_confirmation`。
- 历史 `waiting_confirmation`：轮次暂停前账本已随会话落库；等待期间账本无写入，远端侧无任何调用。恢复轮次 `restore` 同一会话账本继续累积，新证据追加而非覆盖。
- handoff 补查：补查仍在客户端分支内执行，新观测正常入账；远端补查走新的 `ExternalConsultation`，产出仍只进 `external_findings`。

### 6.4 并发隔离

账本状态存在会话记录内，写入随「会话级准入」天然串行——同一会话同一时刻只有一个活跃轮次，不存在两个轮次并发写同一账本。不同会话的账本完全独立，无任何共享可写状态；全局并发闸门不改变这一性质。

## 7. 多用户并发与会话隔离

### 7.1 隔离不变量（必须保持）

- 每轮诊断拥有独立 `runId`、`CapabilitySession`、MCP client 进程、工具预算和证据账本；远端任务拥有独立 `taskId`。
- 同一会话任意时刻最多一个活跃轮次（Web 409 / IM 排队一条，行为不变）。
- 只读共享：知识库文件、版本登记表和按 `repository_id + commit` 缓存的源码快照；可追加共享：`.data/knowledge-queries.jsonl`（append-only，逐行自包含）。

### 7.2 全局并发闸门

- `HARMONY_AGENT_MAX_CONCURRENT_RUNS`（默认 4）限制单进程活跃轮次。超限行为按入口区分：Web 返回 `429 + retry_after` 提示，前端只提示不自动重试（避免惊群）；IM 进入该用户的已有队列（容量 1 不变）。
- 闸门在准入时占位、终态释放；**占位失败不持久化任何消息**（与现有「初始写入失败释放准入」一致）。
- **历史 `waiting_confirmation` 释放全局槽位**：旧审批轮次可能挂数小时，不能占用并发额度；用户批准后启动的恢复轮次作为新轮次**重新走完整准入**（全局闸门 + 会话互斥），不享受特权。新的自动协查在同一活跃轮次内完成，按正常终态释放槽位。
- 终态持久化失败时保留占位，由启动恢复逻辑接管（§9）。

### 7.3 多进程演进预留

- 准入逻辑已收敛为 `RunAdmission` 接口：`acquire(conversationId) / release(runId)`。当前为进程内实现；多进程部署前必须替换为 LibSQL lease（`run_lease(conversation_id, owner, expires_at)`，CAS 获取，启动时回收过期 lease）。接口语义需支持续期：长诊断超过 `expires_at` 时由持有方续期，否则 lease 回收会把活跃轮次误判为死锁。
- 当前只有接口和单进程实现，**没有 lease**；多进程仍不受支持。

## 8. HTTP / SSE 接线

当前事件（AG-UI 兼容层映射）：

| 事件 | 时机 |
| --- | --- |
| `INVESTIGATION_PLAN` | 计划生成后，携带 mode/branches/reason |
| `EXTERNAL_CONSULTATION_REQUIRED` | 仅用于恢复历史待审批会话；新自动协查不发送该事件 |
| `BRANCH_STATUS` | 分支开始/完成/失败/取消，含 branch 与摘要 |
| `JOINT_ASSESSMENT` | 聚合完成，含 responsibility |

兼容与归属约定：

- **旧前端必须忽略未知 SSE 事件**——新增事件的兼容契约已由前端适配和契约测试固定。
- 并行模式下两个分支的事件交错到达：所有分支相关事件（含现有 `TOOL_CALL_*`）在并行模式增加 `branch` 字段；`local` 模式不下发该字段，保持旧前端所见不变。
- `RUN_FINISHED` 语义不变；单分支（local）会话不下发 `INVESTIGATION_PLAN` 以外的新事件。
- **计划与分支事件用于审计和进度展示，不作为用户操作题**：前端把 loop 状态呈现为「正在检查应用 / 正在进一步协查 / 正在整理结论」等通俗进度；不得弹出「请选择客户端还是服务端」或「是否调用 Compass」之类的技术选项。历史待审批记录仍展示原固定摘要和操作。

## 9. 持久化改动

- `product_conversations` 的会话记录 additive 增加：`investigation`（初始/当前 plan、计划变更原因、各分支状态）、`consultations`（ExternalConsultation 列表）、`external_findings`（RemoteConclusion 列表）、`slot_audit`（Slot 调用审计，§5）。旧记录缺字段按空值处理。
- Web 新建会话写入当前登录主体的 `owner_subject`；批准/拒绝必须匹配该主体，缺失 owner 的旧记录对外发审批失败关闭，不以“旧数据”为由放行。普通 CRUD 的完整多用户隔离仍需单独收敛，不能由审批 owner 校验推断整个数据面已隔离。
- 重启修复保留“`waiting_confirmation` 且存在 pending 咨询”的可恢复暂停态；running 或缺少 pending 的异常 waiting 记录按中断处理，不能留下永远无法操作的会话。
- 分流特征词表 `runtime/contracts/server-signals.yaml` 为代码内置配置，不入库、不可由请求修改。
- 不新增表；lease 演进时再评估。

## 10. 验收

确定性验收（自动化）：

1. 远端未配置或槽位停用 ⇒ Registry 无 compass 可用槽位，计划永远 `local`；新工单即使命中服务端特征并带 traceId，没有本地日志观测也仍先 `local`；已有 `kind=log` 观测且满足其余条件时才可直接 `parallel`。
2. 新协查自动执行且只发送已保存的固定脱敏 `outbound_text`，不产生用户审批；历史 pending 记录未确认前 mock 端零 HTTP，批准后仍只能发送原摘要。
3. 服务端分支失败/取消，客户端已完成事实保留，报告含缺口说明。
4. 全局闸门：并发达到上限时第 N+1 个 Web 请求得 429 且不持久化消息；终态后槽位释放可再进；`waiting_confirmation` 轮次不占槽位，恢复轮次重新走准入。
5. 同会话并发仍 409；不同会话并行完成且证据账本互不污染。
6. 远端结论不进 `evidence_refs`；`joint_assessment` 标注外部来源；`verified_claims` 引用不存在的本地证据 ID 或外部 ID 时报告提交被拒绝，不静默降级。
7. 并行执行期间服务端分支对账本零写入；`waiting_confirmation` 暂停与恢复轮次前后账本状态一致，恢复后新证据追加而非覆盖。
8. 本地取消 ⇒ `CancelTask` 到达 mock 端；远端状态未知记 `unknown`，不伪造。
9. 预算到期 ⇒ 远端收到 `CancelTask`，半截结论标 `truncated`，本地分支照常收尾；联合阶段缺失时 `joint_assessment` 为 `null`。
10. 初始 `local` 且本地校验后的 `next_action.target=external`、任务类型和预算满足条件 ⇒ Supervisor 自动创建外部协查、更新计划，并在同一轮执行远端与联合阶段，无需用户选择技术路径或审批，handoff 不超过上限。规则/实现查询不要求 traceId；故障诊断缺少本地观测或关联信息时不得自动跨侧，用户限定只查客户端或远端不可用时不外发。
11. 契约测试：旧前端忽略 `INVESTIGATION_PLAN` / `BRANCH_STATUS` / `JOINT_ASSESSMENT` 后行为不变。
12. `observe → source` 门禁：过早源码调用被拒绝；身份匹配的关联日志观察、粘贴 hilog 解析、目录不覆盖、空结果、身份未匹配或查询失败后按状态放行或降级；歧义解析和 count 不放行；降级不得被写成平台确认；跨侧计划切换与恢复时 `clientSteps` 保持一致。

回归：`make test-runtime`、`make test-mcp`、`make knowledge-validate`。

## 11. 已完成落地顺序

| 顺序 | 内容 | 当前状态 |
| --- | --- | --- |
| M1 | `RunAdmission` 接口、全局并发闸门和恢复测试 | 已完成 |
| M2 | `AgentSlotRegistry`、Compass Slot 和远端可用性控制 | 已完成 |
| M3 | Supervisor 计划、分支、预算 deadline 和 SSE 事件 | 已完成 |
| M4 | 自动协查、历史审批兼容、联合报告校验和有界 handoff | 已完成 |
| M5 | 验收矩阵、前端事件适配及 `observe → source` 门禁 | 已完成 |

后续修改只增量更新本文和当前架构，不再新增平行的编排“现状”文档。真实生产学员日志链与观察后的自动源码换绑尚未完成，不能借用上述编排验收结果宣称其已经通过。
