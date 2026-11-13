# Compass A2A 接入规格

> 状态：P0 传输与 P1 受控联合排查均已实现；真实 Compass Agent 已做过受控联调。
> 范围：Mastra TypeScript Runtime。
> 关联：[当前架构](../docs/ARCHITECTURE.md)、[编排层实现](../docs/orchestration-layer-design.md)。

本文是 Compass 这个 A2A Agent Slot 的接入契约。通用调查计划、自动协查、历史审批恢复、预算和联合报告由 Runtime Supervisor 所有；Compass 不拥有客户端编排，也不承担客户端日志查询。

## 1. 角色与证据边界

```text
Web / IM
   → Hono / RunAdmission
   → Runtime Supervisor
       ├─ ClientBranch → DiagnosisAgent → 本地知识 / 仓库 / 可选日志工具
       └─ ServerBranch → AgentSlotRegistry → CompassSlot
                                      → CompassA2AClient
                                      → 统一外部全栈 Agent（前端 / H5 / 服务端）
   → 本地 EvidenceLedger + external_findings → 联合报告
```

- 客户端只有一个统一 `DiagnosisAgent`，不按 HarmonyOS、Android、iOS 复制 Agent。
- 本地分支只挂载本地 Knowledge MCP；本项目前端、H5 和服务端的知识、代码与日志由 Compass 对端自己管理。
- 模型不能直接调用 Compass 叶子客户端，也没有可绕过 Supervisor 的 `ask_compass` 自由文本工具。
- Compass 返回是外部 Agent 结论，保存为 `RemoteConclusion` / `external_findings`，永不进入本地 `evidence_refs`。
- `responsibility` 只表示当前证据支持的责任判断；`next_action.target=external` 才表示请求统一外部全栈 Agent，两者不能互相替代。
- 调查计划的 `externalScope=frontend_backend` 是产品路由语义，表示远端覆盖本项目前端、H5 和服务端；持久化计划中的 `server` 分支名仅为兼容旧记录。

## 2. 传输与配置

模块：`runtime/src/capabilities/compass-a2a.ts`、`runtime/src/capabilities/compass-slot.ts`。

| 配置 | 说明 |
| --- | --- |
| `HARMONY_AGENT_A2A_BASE_URL` | Compass origin，不含 `/compass` 路径、凭证、query 或 fragment |
| `HARMONY_AGENT_A2A_CLIENT_ID` | `X-A2A-Client-Id` |
| `HARMONY_AGENT_A2A_TOKEN` | 应用 Bearer Token；只放本地 `.env`，为空则失败关闭 |
| `HARMONY_AGENT_A2A_WAIT_SECONDS` | 单次等待上限 |

`CompassA2AClient` 已实现：

- `fetchAgentCard()`：验证 JSONRPC、协议 1.0、同源和 `/compass/a2a`。
- `sendStreamingMessage()`：`SendStreamingMessage`，消费 SSE artifact 文本直到任务终态。
- `cancelTask()`：`CancelTask`，本地取消和超时时尽力调用。
- 输出限长、截断标记、异常与未知终态处理。

请求使用 `Authorization: Bearer …`、`A2A-Version: 1.0` 和客户端标识头。网页 SSO 与 A2A 应用 Token 是两套独立身份。

## 3. Supervisor 调用规则

### 3.1 初始计划

- 常规协查是否执行只取决于 Runtime 的远端可用性、调查范围、证据与预算规则；`consult_compass` 是保留用于旧记录读取的历史字段，不再作为用户开关或路由门槛。
- 新工单即使命中服务端关键词并带 traceId/requestId，只要 EvidenceLedger 没有本地 `kind=log` 观测，仍先执行 `local`。
- 已有本地日志观测，同时满足服务端信号、请求关联标识、远端可用性和预算时才可直接 `parallel`。
- 用户明确限定只查服务端时可以生成 `server` 计划，并由 Runtime 自动执行，不向老师展示技术路由或审批操作。
- 学员编号和联系电话不等于请求级关联标识，不能单独满足 `correlationReady`。

### 3.2 自动外部接续

本地报告经证据校验后，`next_action.target=external` 和明确调查问题即可请求统一外部全栈 Agent；`responsibility` 只保留责任判断，不作路由门槛。`task_type=rule/implementation` 的项目内规则与实现查询在本地知识不足时可自动协查，不要求本地源码/日志观测或 traceId/requestId，也不据此推断服务端责任。`task_type=incident` 的故障诊断仍要求本地源码/日志观测；缺少 traceId/requestId 时不阻断协查，由外发摘要显式声明关联缺口，请外部 Agent 按学员标识与时间窗关联。所有路径都受用户范围、远端可用性、预算和 handoff 上限约束。

自动接续不是两个 Agent 自由对话：计划变化会持久化，旧本地结果保留；服务端计划必须将 `clientSteps` 置空，恢复时不能继续携带客户端观察阶段。

### 3.3 自动协查与固定外发边界

每个外部调查范围启动前：

1. Runtime 按固定结构组装出站摘要并保存 `ExternalConsultation` 与摘要 digest：`用户问题原文`（本会话全部用户消息，逐条与总量限长）+ `关联信息`（traceId/requestId，缺失时显式声明关联缺口）；本地报告已产生时追加 `本地调查证据`（账本校验过的逐字摘录，按条限长）、`本地判断`（摘要/责任/疑似位置/候选/缺口，标注未验证）和 `请协查的问题`（本地报告的 next_action）。
2. Runtime 按固定策略自动把记录置为内部 `approved`，随后在同一轮调用 Slot 并进入联合阶段；`approved` 不表示老师执行过审批，新请求不产生 `waiting_confirmation`。
3. 老师只看到“正在进一步协查”等通俗进度和最终结果，不需要知道 Compass、A2A 或前端/服务端路由。
4. 模型不能覆盖外发结构、URL、Token 或槽位参数——进入外发的模型产出仅限账本已校验的报告字段；Compass 可在当前摘要范围内自主使用自己的知识和工具，不为其内部步骤重复交互。
5. 不发送完整工具结果原文或附件，只发送证据账本中经逐字校验的摘录（含学员标识、电话等观测事实，内网链路不伪名化、不脱敏）。新增调查范围时创建新的固定摘要和协查记录，仍受预算与 handoff 上限约束。
6. 历史 `pending` 会话继续使用原批准/拒绝接口和 `waiting_confirmation` 恢复协议；接口仍校验 owner、CSRF、会话、轮次和 digest。该兼容路径不改变新请求的自动执行行为。

Compass 及其模型链路均在内网，外发正文使用用户原文，学员编号/电话/凭证均不伪名化、不脱敏（2026-11-13 起全链路明文），本地证据摘录与本地判断一并外发；traceId/requestId 保留为请求关联信息。真实学员数据和生产日志链路尚未联调，PII 策略仍需随真实联调复查。

## 4. 结果、取消与联合报告

- ServerBranch 不持有、不读写 EvidenceLedger。
- 任一侧失败或取消不能覆盖另一侧已完成事实；远端状态无法确定时保存 `unknown`，不伪造成功。
- 预算到期先尽力 `CancelTask`；已收到的半截内容标记 `truncated`，不能展示成完整结论。
- 联合阶段把结构化 `RemoteConclusion` 交给客户端 Agent 生成 `joint_assessment`，不是把远端文本登记为观测。
- `joint_assessment.verified_claims` 只能引用本地有效证据；consultation/task ID 或伪造 ID 会被拒绝。
- 仅远端支持的主张进入 `unverified_claims` 并注明“仅来自远端 Agent 报告”。
- Slot 调用审计保存 slot、task、状态、耗时和截断等元数据，不保存凭证。

## 5. 当前验证边界

离线测试覆盖 Agent Card、SSE、终态、自动协查、固定结构摘要、历史审批前零请求、owner/CSRF、恢复、取消、输出限长、并行分支、外部结论隔离和联合报告引用。真实 Compass 联调已验证 Agent Card、SSE、历史审批恢复、外部结论与联合报告链路；自动协查主路径当前由离线测试验收。

这些结果不证明：

- Compass 能查询当前学员的 Android/iOS/HarmonyOS 客户端日志；它不是该能力的默认提供方。
- 多进程部署已支持；当前仍只有单进程 RunAdmission。
- 远端每次诊断都正确；外部结论仍需保留来源和未验证边界。
- Compass 跨轮 `contextId`、独立 Compass UI 和进度多路复用已经完成；它们不是当前验收范围。

## 6. 回归入口

```bash
cd runtime
node --import tsx --test \
  test/compass-a2a.test.ts \
  test/compass-slot.test.ts \
  test/agent-slot-registry.test.ts \
  test/consultation-routes.test.ts \
  test/investigation-loop.test.ts
```

完整回归使用 `make test-runtime`。真实联调只使用本地凭证和经过批准的测试内容，不把 Token、学员隐私或远端原文写入测试夹具和文档。
