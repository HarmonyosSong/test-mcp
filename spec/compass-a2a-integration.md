# Compass A2A 接入规格

> 状态：已批准分阶段实施（2026-11-05）  
> 范围：Mastra TypeScript runtime（`runtime/`）  
> 关联：Compass A2A 1.0 JSON-RPC；本仓库 AG-UI/SSE 聊天链路；[`多能力扩展规划`](../docs/multi-capability-expansion-plan.md)；[`多能力扩展技术设计`](../docs/multi-capability-technical-design.md)

本文是 Troubleshoot Odyssey 中 Compass A2A 的唯一接入契约。客户端保留自己的本地 Knowledge MCP；云学习知识由云学习服务端 Agent 管理，客户端通过 Compass A2A 调用该 Agent，不直连云学习 Knowledge MCP。

## 1. 目标与阶段

本仓库的 Mastra runtime 是 A2A 客户端和客户端问题诊断归属方；Compass 对端是云学习服务端 Agent，负责其服务端知识与排查流程。A2A 输出属于外部 Agent 结论，不是客户端的现场观测证据。

| 阶段 | 交付物 | 状态 |
| --- | --- | --- |
| **P0 — 客户端能力** | 配置 + A2A 客户端（Agent Card、`SendStreamingMessage` SSE、终态文本、`CancelTask` API） | **已实现** |
| **P1 — 受控联合排查** | 分层取证、触发与授权、外发硬门控、结果复核、责任归属和 `CancelTask` | **规划已定义** — runtime 与报告 Schema 待实现，见 §4.5 |
| **P2 — 产品体验** | 进度多路复用、会话 `contextId` | **未实现** — 后续流程，不阻塞 P1 |

聊天 Agent 调用 Compass 在 P1 完成前**暂不支持**。配置 A2A Token 本身不得自动使工具对模型可见。

## 2. 已锁定决策

| 项 | 决策 |
| --- | --- |
| Runtime | Mastra TypeScript 客户端：`runtime/src/capabilities/compass-a2a.ts` |
| 配置 | 全部经 `loadRuntimeConfig()` / 仓库根 `.env`；非敏感默认值在 `.env.example` 与 `A2A_CONFIG_DEFAULTS` |
| 传输 | Compass Agent Card → JSON-RPC 1.0，地址 `{origin}/compass/a2a` |
| 认证 | 应用 Bearer Token（`HARMONY_AGENT_A2A_TOKEN`）与客户端标识头（`HARMONY_AGENT_A2A_CLIENT_ID`）；与网页 SSO 无关 |
| 证据 | Compass 输出是外部助手结论，**不得**写入 diagnosis `evidence_refs` |
| 默认 origin | 来自配置 / `.env.example`（仅 origin，不含 `/compass` 路径） |
| Token 为空 | 视为未配置；客户端构造必须失败关闭 |

P0–P2 非目标：独立 Compass UI；把 Compass 文本当观测源码/日志证据。联合排查的产品编排契约见 §4.5；契约完成不代表当前聊天路径已具备该能力。

## 3. 当前能力（P0）

### 3.1 配置

环境变量由仓库根 `.env` 读入 `runtime/src/config.ts`。**禁止**在客户端内写死环境相关取值。

| 变量 | 是否写入 `.env.example` | 说明 |
| --- | --- | --- |
| `HARMONY_AGENT_A2A_BASE_URL` | 是（非敏感默认） | 仅 origin |
| `HARMONY_AGENT_A2A_CLIENT_ID` | 是（非敏感默认） | 作为 `X-A2A-Client-Id` 发送 |
| `HARMONY_AGENT_A2A_WAIT_SECONDS` | 是（非敏感默认） | 单次调用等待上限 |
| `HARMONY_AGENT_A2A_TOKEN` | 是，**留空** | 敏感 — 只写在本地 `.env` |

Runtime 字段：`a2aBaseUrl`、`a2aClientId`、`a2aToken`、`a2aWaitSeconds`。  
辅助函数：`compassA2AClientConfig(config)` 把 runtime 配置映射为客户端构造参数。

### 3.2 客户端 API

模块：`runtime/src/capabilities/compass-a2a.ts`

- `isCompassA2AConfigured(token)`
- `normalizeCompassA2ABaseUrl(url)` — 拒绝带 path/`/compass`、凭证、query/fragment
- `CompassA2AClient` — 必须从配置传入 `baseUrl`、`clientId`、`token`、`waitSeconds`（无内嵌产品默认值）
  - `fetchAgentCard()` — 要求 `supportedInterfaces` 中有 `protocolBinding=JSONRPC`、`protocolVersion=1.0`、同源、path 为 `/compass/a2a`
  - `sendStreamingMessage({ text, contextId?, onProgress?, abortSignal? })` — 方法 `SendStreamingMessage`；用户角色线上值为 `ROLE_USER`；收集 artifact 文本直到任务终态
  - `cancelTask(taskId)` — 方法 `CancelTask`（尽力而为；已完成任务可能不可取消）

请求头：`Authorization: Bearer …`、`A2A-Version: 1.0`、`X-A2A-Client-Id: …`。

### 3.3 验证

- 单测：`runtime/test/compass-a2a.test.ts`（Mock Agent Card + SSE）
- 联调冒烟（手工，仅本地 Token）：Agent Card HTTP 200；短问 `SendStreamingMessage` 返回带 `TASK_STATE_COMPLETED` 与 artifact 文本的 SSE

P0 **不**注册工具，**不**注入 `toolsets`，**不**改 `DiagnosisAgent` 指令。

## 4. 后续使用与接入流程（P1–P2）

本节是产品侧后续接入流程说明，实现前仅作规格指引。

### 4.1 `ask_compass` 是什么

原生 Mastra Tool（`createTool`），用于在用户开启会话能力并逐次确认外发内容后，让客户端 Agent 请求云学习服务端 Agent：

- 不是 MCP 工具
- 不是 Skill 文档
- 封装 `CompassA2AClient.sendStreamingMessage`
- 建议工具 id：`ask_compass`

本地 Knowledge MCP 与 `ask_compass` 职责不同：前者查客户端自己的知识；后者调用拥有独立知识和排查流程的服务端 Agent。

### 4.2 P1 — 工具注册（未实现）

实现时：

1. 新增能力模块，用 `createTool` 导出 `ask_compass`。
2. 工具只有在 A2A Token 已配置且会话级 `consult_compass` 显式开启时才注入；开关由 UI 用户操作设置，普通聊天文本或模型输出不得设置它。开关关闭时模型物理上不可调用。模型请求调用后，Runtime 展示本次准确的脱敏出站摘要并等待用户确认；确认前不发 HTTP，请求被拒绝时返回无副作用的取消结果。
3. 工具 schema 不接收自由文本。Runtime 从当前轮已绑定的用户消息生成唯一待发送文本并执行独立的外发脱敏；模型不能附加历史消息、源码、日志或自行拼装请求。首版不发送客户端本地源码、日志或工具结果；以后如开放附加内容，必须由 Runtime 逐项展示并取得本次明确确认。
4. 用 `compassA2AClientConfig(config)` 构造客户端，不在工具内写死 URL 或 client id。
5. abort 或超时后尽力调用远端 `CancelTask`；响应设定字符上限并显式标记为不可信的服务端 Agent 结论。
6. Compass 输出不得登记为源码/日志观测，诊断证据账本不得因该输出变化。提示词只能作为补充防护。
7. 验收：开关关闭或 Token 为空时无工具；本次调用未确认或被拒绝时 mock 端零 HTTP 请求；模型试图传入源码/日志时拒绝且 mock 端零 HTTP 请求；正常调用返回终态文本；取消后 mock 收到 `CancelTask`；超长结果被标记截断。

### 4.3 P2 — 产品体验（未实现）

P1 之后可选；每项都会更深触及流式/会话：

| 项 | 意图 | 触及点 |
| --- | --- | --- |
| 进度多路复用 | 调用中 `onProgress` → UI 工具步骤持续更新 | 诊断流事件 + 会话 SSE（必要时前端 upsert） |
| 会话 `contextId` | 跨轮复用 Compass 上下文 | 会话持久化字段 + 工具依赖 |

远端任务取消属于 P1 生命周期要求；P2 只覆盖进度和跨轮上下文体验。

### 4.4 当前明确不支持

- 会话开关关闭时调用 Compass
- Agent 工具集中的 `ask_compass`（或任何别名）
- 客户端直接挂载或调用云学习 Knowledge MCP
- Compass 进度 UI
- P1 联合排查流程的聊天路径接线（触发、逐次确认和结果复核）

### 4.5 P1 — 客户端与服务端联合排查编排

这一节定义产品流程，不改变 A2A 的传输职责。客户端 Agent 负责客户端知识、仓库和本地可见观测；云学习服务端 Agent 负责服务端知识、代码和服务端日志。一个问题同时涉及两侧时，必须按以下顺序执行：

1. **客户端初筛**：先确认客户端平台、入口、时间范围、请求关联标识和本地可见事实。发现 API、Bridge、服务端任务或服务端数据关联线索后，才进入服务端咨询；没有关联线索时不自动调用 Compass。
2. **授权确认**：会话级 `consult_compass` 开关默认关闭，只控制本会话是否允许咨询。每次调用前 Runtime 展示咨询原因和准确的脱敏出站摘要，并取得用户确认；附加客户端日志、源码或工具结果时，逐项列明并确认。打开会话开关不授权模型自动发起所有后续调用。
3. **受控发送**：Runtime 生成 `server_consult_context`，绑定当前轮问题、会话端、服务、环境、已确认的关联标识和时间范围。模型不能自由传入历史消息、源码、日志或其他上下文。若服务端查询必须使用原始关联标识，确认摘要必须明确展示该值；若标识已脱敏或伪名化到无法查询，不得声称完成了针对该请求的服务端关联。
4. **服务端分析**：服务端 Agent 使用自己的知识和服务端能力分析，返回任务终态、结论、适用范围和限制条件。客户端不直连服务端 Knowledge MCP。
5. **客户端复核**：Runtime 将结果保存为独立的 `remote_conclusion` / `external_findings`。客户端 Agent 把服务端主张拆成可本地验证和只能服务端验证两类，再用本地代码、请求结果或已授权观测进行交叉验证。
6. **联合输出**：报告分别展示客户端事实、服务端 Agent 结论、跨侧综合判断和未解决缺口。远端结果永远不进入 `evidence_refs`；只有实际本地观测才能支撑客户端根因候选。

Runtime 层的最小结果形态为：

| 字段 | 用途 | 证据地位 |
| --- | --- | --- |
| `remote_conclusion` | 单次服务端 Agent 的任务、来源、结论、限制和终态 | 外部结论，不进 `evidence_refs` |
| `external_findings` | 多条可独立展示的服务端发现 | 外部结论，不进 `evidence_refs` |
| `joint_assessment` | 客户端事实与服务端结论的匹配、冲突或未验证说明 | 综合判断，必须保留双方来源边界 |
| `responsibility` | `client` / `server` / `shared` / `unknown` | 当前责任路由判断，不是观测证据或诊断 verdict |

其中 `server` 责任状态只能表示“当前排查路由指向服务端”；若依据只是服务端 Agent 报告，必须在 `joint_assessment` 标明其外部来源，不能升级为客户端已确认的服务端事实。它与 `located` / `probable` / `insufficient_evidence` 等诊断 verdict 分离。A2A 失败、超时、取消或截断时，保留失败状态和缺口，不影响已经完成的本地诊断。

## 5. 角色边界（P1 之后目标形态）

```text
用户 <-> Web (AG-UI SSE)
         |
         v
   Mastra DiagnosisAgent
         |  （未来）tool: ask_compass
         v
   CompassA2AClient  （P0 — 已有）
         |
         v
   云学习服务端 Agent /compass/a2a
         |
         +--> 服务端知识与排查能力（由对端管理）
```

- 客户端 runtime：负责客户端知识、客户端仓库证据和本地诊断；按会话开关控制是否请求对端 Agent。
- 云学习服务端 Agent：负责服务端知识和服务端排查，通过 A2A 返回任务状态与最终结果。
- A2A 返回是外部线索，不作为客户端故障的源码/日志证据。
- Token 只代表应用身份；不含员工写权限/部署权限。

## 6. 风险与约束

- Compass 排查本身可能较慢；过程可见属于 P2。
- 会话显式开关、每次调用的用户确认与外发硬门控必须由 Runtime 强制执行，不能只依赖弱提示。
- 挂载后，本轮共享工具预算会把 `ask_compass` 计入。
- 真实 Token 只放本地 `.env`；**禁止**写入 `.env.example`。

## 7. 文件对照

| 层 | 路径 | 阶段 |
| --- | --- | --- |
| 配置 | `runtime/src/config.ts`、`.env.example` | P0 |
| 客户端 | `runtime/src/capabilities/compass-a2a.ts` | P0 |
| 测试 | `runtime/test/compass-a2a.test.ts` | P0 |
| 规格 | `spec/compass-a2a-integration.md` | P0 |
| 工具（未来） | 能力模块 + `createTool` | P1 |
| toolset 挂载（未来） | `runtime/src/http/conversations.ts` | P1 |
| 流式/体验（未来） | `runtime/src/diagnosis/agent.ts`、会话 SSE、前端工具卡片 | P2 |

## 8. 验收清单

**P0（当前）**

1. Token 为空 ⇒ `isCompassA2AConfigured` 为 false；构造客户端抛错。
2. Base URL 带 `/compass` 被拒绝。
3. Mock Card + SSE ⇒ `sendStreamingMessage` 返回 artifact 文本与终态。
4. 客户端可调用 `CancelTask` JSON-RPC。
5. `.env.example` 含非敏感 A2A 基础项；Token 留空。
6. 产品聊天路径尚无诊断/toolset 接线；底层配置不得自动开放调用。

**P1 / P2** — 见 §4 与 [`多能力扩展规划`](../docs/multi-capability-expansion-plan.md)；落实工具注册和联合排查前应以本规格为唯一契约。
