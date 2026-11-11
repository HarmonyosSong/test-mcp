# Compass A2A 接入规格

> 状态：P0 传输与 P1 受控联合排查均已实现；真实云学习 Agent 已做过受控联调。
> 范围：Mastra TypeScript Runtime。
> 关联：[当前架构](../docs/ARCHITECTURE.md)、[编排层实现](../docs/orchestration-layer-design.md)。

本文是 Compass 这个 A2A Agent Slot 的接入契约。通用调查计划、审批恢复、预算和联合报告由 Runtime Supervisor 所有；Compass 不拥有客户端编排，也不承担客户端日志查询。

## 1. 角色与证据边界

```text
Web / IM
   → Hono / RunAdmission
   → Runtime Supervisor
       ├─ ClientBranch → DiagnosisAgent → 本地知识 / 仓库 / 可选日志工具
       └─ ServerBranch → AgentSlotRegistry → CompassSlot
                                      → CompassA2AClient
                                      → 云学习服务端 Agent
   → 本地 EvidenceLedger + external_findings → 联合报告
```

- 客户端只有一个统一 `DiagnosisAgent`，不按 HarmonyOS、Android、iOS 复制 Agent。
- 客户端只挂载本地 Knowledge MCP；云学习知识、代码和服务端日志由 Compass 对端自己管理。
- 模型不能直接调用 Compass 叶子客户端，也没有可绕过 Supervisor 的 `ask_compass` 自由文本工具。
- Compass 返回是外部 Agent 结论，保存为 `RemoteConclusion` / `external_findings`，永不进入本地 `evidence_refs`。
- `responsibility=server` 只表示当前路由指向服务端，不等于本地已经验证服务端根因。

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

- 会话级 `consult_compass` 默认关闭，只能由受保护的用户操作修改；普通聊天文本和模型输出不能开启。
- 新工单即使命中服务端关键词并带 traceId/requestId，只要 EvidenceLedger 没有本地 `kind=log` 观测，仍先执行 `local`。
- 已有本地日志观测，同时满足服务端信号、请求关联标识、Compass 开关和预算时才可直接 `parallel`。
- 用户明确限定只查服务端时可以生成 `server` 计划，但仍须经过外发审批。
- 学员编号和联系电话不等于请求级关联标识，不能单独满足 `correlationReady`。

### 3.2 自动跨侧

本地报告经证据校验后，如果结构化 `responsibility` 和 `next_action` 给出明确跨侧调查问题，Supervisor 可在预算和 handoff 上限内自动创建服务端计划。IT 老师不需要选择技术路由。

自动接续不是两个 Agent 自由对话：计划变化会持久化，旧本地结果保留；服务端计划必须将 `clientSteps` 置空，恢复时不能继续携带客户端观察阶段。

### 3.3 外发审批

每个服务端调查范围首次启动前：

1. Runtime 从绑定的当前轮用户文本生成固定脱敏出站摘要，保存 `ExternalConsultation`。
2. 前端展示接收方、调查范围和准确摘要；未批准、拒绝或过期时 mock/真实端均不得收到任务请求。
3. 批准/拒绝接口校验会话 owner、CSRF、会话和轮次，不能接受文本、URL、Token 或模型参数覆盖摘要。
4. 批准范围内 Compass 可自主使用自己的知识和工具，不为对端每个内部步骤重复弹窗。
5. 新增客户端日志、源码、关联标识或扩大服务/环境范围时必须创建新审批。
6. `waiting_confirmation` 释放全局并发槽位；批准后以新轮次重新准入，不能把半截工具调用交给模型。

首版不向 Compass 发送本地源码、日志正文或工具结果。默认出站摘要已在通用凭证脱敏之外增加学员编号和电话脱敏，并由合成测试覆盖；traceId/requestId 保留为审批后的请求关联信息。真实学员数据和生产日志链路尚未联调，不据此宣称完整 PII 策略已通过生产验收。

## 4. 结果、取消与联合报告

- ServerBranch 不持有、不读写 EvidenceLedger。
- 任一侧失败或取消不能覆盖另一侧已完成事实；远端状态无法确定时保存 `unknown`，不伪造成功。
- 预算到期先尽力 `CancelTask`；已收到的半截内容标记 `truncated`，不能展示成完整结论。
- 联合阶段把结构化 `RemoteConclusion` 交给客户端 Agent 生成 `joint_assessment`，不是把远端文本登记为观测。
- `joint_assessment.verified_claims` 只能引用本地有效证据；consultation/task ID 或伪造 ID 会被拒绝。
- 仅远端支持的主张进入 `unverified_claims` 并注明“仅来自远端 Agent 报告”。
- Slot 调用审计保存 slot、task、状态、耗时和截断等元数据，不保存凭证。

## 5. 当前验证边界

离线测试覆盖 Agent Card、SSE、终态、审批前零请求、owner/CSRF、恢复、取消、输出限长、并行分支、外部结论隔离和联合报告引用。真实云学习联调已验证 Agent Card、SSE、审批恢复、外部结论与联合报告链路。

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
