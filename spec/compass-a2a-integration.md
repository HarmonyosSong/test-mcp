# Compass A2A 接入规格

> 状态：已批准分阶段实施（2026-11-05）  
> 范围：Mastra TypeScript runtime（`runtime/`）  
> 关联：Compass A2A 1.0 JSON-RPC；本仓库 AG-UI/SSE 聊天链路

本文是 Troubleshoot Odyssey 中 Compass A2A 的发布契约：记录**当前已实现能力**，以及**刻意延后的后续使用 / 产品接入流程**。

## 1. 目标与阶段

在本阶段提供经校验的、只读的 A2A 通路到 Compass；**不改**诊断编排，也**不改**分层取证定位。

| 阶段 | 交付物 | 状态 |
| --- | --- | --- |
| **P0 — 客户端能力** | 配置 + A2A 客户端（Agent Card、`SendStreamingMessage` SSE、终态文本、`CancelTask` API） | **已实现** |
| **P1 — 工具注册** | 原生 Mastra `createTool`（建议名 `ask_compass`），可选挂入 `toolsets` | **未实现** — 后续流程 |
| **P2 — 产品体验** | 进度多路复用、会话 `contextId`、断开时 Cancel | **未实现** — 后续流程 |
| **P3 — 诊断编排** | 分层取证 /「何时问 Compass」策略 | **本文不覆盖** — 另行设计 |

产品侧调用路径（**聊天 Agent 如何调用 Compass**）在 P1 完成前**暂不支持**。

## 2. 已锁定决策

| 项 | 决策 |
| --- | --- |
| Runtime | Mastra TypeScript 客户端：`runtime/src/capabilities/compass-a2a.ts` |
| 配置 | 全部经 `loadRuntimeConfig()` / 仓库根 `.env`；非敏感默认值在 `.env.example` 与 `A2A_CONFIG_DEFAULTS` |
| 传输 | Compass Agent Card → JSON-RPC 1.0，地址 `{origin}/compass/a2a` |
| 认证 | 应用 Bearer Token（`HARMONY_AGENT_A2A_CLIENT_ID`）；与网页 SSO 无关 |
| 证据 | Compass 输出是外部助手结论，**不得**写入 diagnosis `evidence_refs` |
| 默认 origin | 来自配置 / `.env.example`（仅 origin，不含 `/compass` 路径） |
| Token 为空 | 视为未配置；客户端构造必须失败关闭 |

P0–P2 非目标：独立 Compass UI；把 Compass 文本当观测源码/日志证据；改分层取证流程。

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

原生 Mastra Tool（`createTool`），与 `resolve_external_knowledge` / `read_external_knowledge` 同类：

- 不是 MCP 工具
- 不是 Skill 文档
- 封装 `CompassA2AClient.sendStreamingMessage`
- 建议工具 id：`ask_compass`

最接近的现有模式：`runtime/src/http/conversations.ts` 里可选注入的外部知识 toolset。

### 4.2 P1 — 工具注册（未实现）

实现时：

1. 新增能力模块，用 `createTool` 导出 `ask_compass`。
2. 若 `isCompassA2AConfigured(config.a2aToken)`，向每轮 `toolsets` 注入 `{ compass: { ask_compass } }`，与知识/仓库/外部知识并列。
3. 用 `compassA2AClientConfig(config)` 构造客户端 — 不要再写死 URL 或 client id。
4. **不要**改分层取证捕获规则；Compass 结果不得变成源码/日志证据。
5. 可选弱提示：仅当用户明确要求问 Compass / 企业只读排查时调用；Compass 文本不是现场证据。
6. 验收：Token 空 ⇒ 无工具；Token 有 ⇒ 模型可调 `ask_compass` 并拿到终态文本；诊断证据账本对 Compass 输出不变。

### 4.3 P2 — 产品体验（未实现）

P1 之后可选；每项都会更深触及流式/会话：

| 项 | 意图 | 触及点 |
| --- | --- | --- |
| 进度多路复用 | 调用中 `onProgress` → UI 工具步骤持续更新 | 诊断流事件 + 会话 SSE（必要时前端 upsert） |
| 会话 `contextId` | 跨轮复用 Compass 上下文 | 会话持久化字段 + 工具依赖 |
| 断开 Cancel | abort 时尽力 `cancelTask` | 会话中断路径 |

这些**不是** P0/P1 的连通性必要条件。

### 4.4 当前明确不支持

- 产品/聊天内调用 Compass
- Agent 工具集中的 `ask_compass`（或任何别名）
- Compass 进度 UI
- 分层诊断里编排「何时问 Compass」

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
   Compass /compass/a2a
```

- Harmony：诊断归属方；决定是否/何时调用（P3+）。
- Compass：企业只读排查执行方；A2A 返回安全状态与最终文本。
- Token 只代表应用身份；不含员工写权限/部署权限。

## 6. 风险与约束

- Compass 排查本身可能较慢；过程可见属于 P2。
- P1 挂载工具但无说明时，模型偶发自发调用；可用弱提示 +「用户明确要求」约束。
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
6. 产品聊天路径无诊断/toolset 接线。

**P1 / P2** — 见 §4；需另开明确批准后再实现。
