# 架构图

## 运行时边界

```text
浏览器
  | REST + AG-UI 兼容 SSE
  v
runtime/src/server.ts
  |
runtime/src/app.ts                  Hono 产品 API 路由
  |-- ProductStore                  LibSQL 产品数据
  |-- ModelConfiguration             provider/model/API Key 解析
  |-- ClientDiagnosisAgent          统一多端 Mastra Agent + 流事件适配
  |     |-- EvidenceLedger           证据 ID、逐字引用、报告门禁
  |     |-- SkillRegistry             Markdown SKILL.md
  |     `-- toolsets                  本地知识、仓库和可选日志查询
  |-- RepositoryCapability            Git mirror + detached snapshot
  |-- migration/legacy.ts             JSON -> LibSQL 幂等迁移
  |-- capabilities/session.ts        按轮注册、上下文、取消、冲突检查和清理
  |     |-- capabilities/mcp.ts       Python FastMCP：本地知识与仓库读取
  |     `-- log-center.ts             原生 Mastra Catalog/SLS 工具（待真实联调）
  |-- AgentSlotRegistry              远端 Agent 槽位发现、策略和生命周期（规划）
  `-- compass-a2a                     Compass 首个 A2A Slot 适配器（聊天未接线）
```

`migration/legacy.ts` 与 MCP 服务彼此独立：前者导入旧产品数据，后者按诊断请求提供只读能力。

Mastra 负责 Agent 编排、模型调用和 runtime storage 生命周期；Hono 只挂载产品定义的 REST/SSE 路由，不暴露 Mastra 通用管理 API。产品数据由 `ProductStore` 写入 LibSQL，Mastra storage 使用同一 runtime 数据库，但不取代产品表的事实来源。Python 进程只承担 MCP 能力，不拥有产品 HTTP 服务或诊断 Agent。

## 一轮诊断

1. `POST /api/conversations/{id}/messages` 在单进程内按 conversation ID 串行准入，由 `prepareDiagnosisRound` 先持久化用户消息和 streaming 占位，再返回 HTTP 200 / SSE 并启动模型工作。初始写入失败返回服务端错误且释放准入。多进程部署前必须改用数据库 lease/CAS。
2. Web、IM 和评测统一使用 `createRoundCapabilitySession`。Runtime 以不可变的 conversation/message/run ID、工作区和取消信号创建本地知识、仓库与可选 LogCenter 能力；知识不可用时降级，已绑定仓库初始化失败时中止取证并清理已创建的 client。Git 会话使用 immutable detached snapshot，本地目录读取允许根目录内的实时文件。配置缺失的日志工具不挂载。统一 `ClientDiagnosisAgent` 覆盖 HarmonyOS、iOS、Android；Agent Slot Registry 与 Compass A2A 仍只保留适配器，尚未注册聊天工具。
3. `ClientDiagnosisAgent` 使用安全的产品级文本历史（当前 TypeScript 实现类名为 `DiagnosisAgent`）；旧框架内部消息不会直接交给 Mastra。未完成的 assistant 消息和不完整工具对不重放。
4. Mastra stream chunk 在 `diagnosis/agent.ts` 统一转换为文本、工具开始/结束、完成或失败事件。只有已注册的源码读取/搜索和可溯源 hilog 解析产生 EvidenceLedger 观测；本地知识和当前 SLS 查询结果都只是线索。A2A 返回的独立外部结论字段仍属待实现设计。
5. 每个工具开始/结束状态和工具完成时的证据快照先写入产品数据库，再发送对应 SSE 事件。进程重启会保留已完成工具观察，并将正在运行的步骤修复为失败。
6. Hono 将内部事件转换成前端已有的 `RUN_STARTED`、`TEXT_MESSAGE_*`、`TOOL_CALL_*`、`STATE_SNAPSHOT`、`RUN_FINISHED` 和 `RUN_ERROR` SSE 事件。
7. 成功、模型错误、工具错误和取消路径会把 assistant 更新为终态。失败和取消时，已流出的文本保留在 `failed` 展示消息中，结构化报告清空；failed/streaming assistant 消息不作为后续模型历史重放，未完成工具步骤标记为失败。启动时将遗留的 streaming 消息修复为中断状态。存储重开、恢复已完成工具观察和 mock 后续轮已有自动化覆盖；另有一次 production-mode 重启后的真实 provider 浏览器续聊通过。验收范围限于单进程；多进程并发准入、强制断电和文件系统损坏恢复尚未验证。
8. 终态消息会 best-effort 写入诊断案例归档，并独立追加 outcome 到知识查询 JSONL；任一观测写入失败都不改变对话终态。
9. 能力会话关闭时先发出取消，再逆序尝试释放全部 client；部分初始化失败同样清理已取得的资源。LogCenter HTTP 请求继承轮次取消，默认 15 秒超时。工具命名空间或名称冲突会拒绝整个挂载，不覆盖已有工具。

## 持久化

- `product_conversations`：会话、展示消息、证据快照和安全历史。
- 工具开始/结束和证据快照随每个工具事件写回 `product_conversations`；失败消息可保留已展示的部分文本供用户恢复查看，但没有报告，且不进入后续模型历史。
- `product_repositories`：仓库登记信息。
- `product_snapshots`：仓库 Commit 与 detached 工作区元数据。
- `runtime_migrations`、`runtime_migration_items`、`runtime_schema`：迁移幂等、回滚和 schema 版本。
- `.data/knowledge-queries.jsonl`：知识 MCP 查询和终态诊断 outcome；`.data/knowledge-cases/`：终态案例归档。两者是可重建的观测产物，不是对话事实来源。

模型配置仍保存在 `.data/model-config.json`，由 runtime 以 `0600` 权限写入。应用管理的会话、工具摘要、证据状态、报告、SSE 和评测产物会对已配置凭据脱敏；Mastra 内部 logger 已关闭，应用异常及 CLI 错误经过脱敏。隔离 production smoke 曾以 request-scoped sentinel 触发模型连接失败，确认 502 响应与本地进程 stdout 均不回显该值；第三方 provider 库和远端部署日志仍需目标环境验证。

## 能力与安全

- RepositoryCapability 校验 URL、分支、允许根目录、真实路径和 snapshot identity；Git 不操作用户工作树。
- MCP 仓库 client 按会话创建并绑定所选工作区；Git 仓库使用 immutable snapshot，避免远端分支变化改写会话证据。本地目录读取实时文件，不提供快照隔离。
- EvidenceLedger 区分用户描述、知识线索、工具观测和过期证据；每个根因候选都必须链接至少一条源码或日志观测，知识线索与用户描述不能单独作为候选证据。
- Skill 正文从 `skills/` 动态读取，Markdown 是唯一权威来源。
- runtime 不提供 shell、写文件、构建或设备工具。

## 部署形态

开发时 Vite 在 `5174` 提供网页，代理 API 到 runtime `8000`；`RUN_MODE=local` 使用本机身份并强制 loopback，默认 `server` 模式走 SSO。Runtime 按需通过 `uv` 启动 Python MCP，LogCenter 使用原生 TypeScript HTTP 适配器。生产时先构建 `web/dist`，再设置 `HARMONY_MASTRA_SERVE_WEB=true`，runtime 进程由 Hono 提供产品 API 和静态网页，Mastra 负责 Agent 编排及 storage 集成。具体命令以根目录 README 和 `Makefile` 为准。

迁移规格、阶段状态和验收证据见 [`mastra-runtime-migration-spec.md`](mastra-runtime-migration-spec.md)。日志、Graphify 和 A2A 联合排查的目标实现契约见 [`multi-capability-technical-design.md`](multi-capability-technical-design.md)。
