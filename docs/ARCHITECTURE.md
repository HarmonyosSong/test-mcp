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
  |-- DiagnosisAgent                Mastra Agent + 流事件适配
  |     |-- EvidenceLedger           证据 ID、逐字引用、报告门禁
  |     |-- SkillRegistry             Markdown SKILL.md
  |     `-- MCP toolsets              本地知识、仓库及可选外部知识只读能力
  |-- RepositoryCapability            Git mirror + detached snapshot
  |-- migration/legacy.ts             JSON -> LibSQL 幂等迁移
  `-- capabilities/mcp.ts             MCP client 生命周期与工具挂载
        |
        +-- mcp_server/                Python FastMCP：本地知识与仓库读取
        `-- optional external MCP     外部开发知识（显式配置后挂载）
```

`migration/legacy.ts` 与 MCP 服务彼此独立：前者导入旧产品数据，后者按诊断请求提供只读能力。

Mastra 负责 Agent 编排、模型调用和 runtime storage 生命周期；Hono 只挂载产品定义的 REST/SSE 路由，不暴露 Mastra 通用管理 API。产品数据由 `ProductStore` 写入 LibSQL，Mastra storage 使用同一 runtime 数据库，但不取代产品表的事实来源。Python 进程只承担 MCP 能力，不拥有产品 HTTP 服务或诊断 Agent。

## 一轮诊断

1. `POST /api/conversations/{id}/messages` 在单进程内按 conversation ID 串行准入，先持久化用户消息和 streaming 占位记录，再启动模型/MCP 工作。多进程部署前必须改用数据库 lease/CAS。
2. runtime 为本轮创建知识 MCP client，并传入 conversation/message ID 关联查询日志；若知识服务不可用则降级为空 toolset。仓库 MCP client 绑定会话选择的工作区：Git 会话使用 immutable detached snapshot，本地目录会话读取允许根目录内的实时文件。外部开发知识只有配置覆盖后才挂载，且只暴露经契约校验的 resolve/read 两个工具。
3. `DiagnosisAgent` 使用安全的产品级文本历史；旧框架内部消息不会直接交给 Mastra。未完成的 assistant 消息和不完整工具对不重放。
4. Mastra stream chunk 在 `diagnosis/agent.ts` 统一转换为文本、工具开始/结束、完成或失败事件。工具结果只有在实际来源工具返回后才进入 `EvidenceLedger`。
5. 每个工具开始/结束状态和工具完成时的证据快照先写入产品数据库，再发送对应 SSE 事件。进程重启会保留已完成工具观察，并将正在运行的步骤修复为失败。
6. Hono 将内部事件转换成前端已有的 `RUN_STARTED`、`TEXT_MESSAGE_*`、`TOOL_CALL_*`、`STATE_SNAPSHOT`、`RUN_FINISHED` 和 `RUN_ERROR` SSE 事件。
7. 成功、模型错误、工具错误和取消路径会把 assistant 更新为终态。失败和取消时，已流出的文本保留在 `failed` 展示消息中，结构化报告清空；failed/streaming assistant 消息不作为后续模型历史重放，未完成工具步骤标记为失败。启动时将遗留的 streaming 消息修复为中断状态。存储重开、恢复已完成工具观察和 mock 后续轮已有自动化覆盖；另有一次 production-mode 重启后的真实 provider 浏览器续聊通过。验收范围限于单进程；多进程并发准入、强制断电和文件系统损坏恢复尚未验证。
8. 终态消息会 best-effort 写入诊断案例归档，并独立追加 outcome 到知识查询 JSONL；任一观测写入失败都不改变对话终态。

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

开发时 Vite 在 `5174` 提供网页，代理 API 到 runtime `8000`；runtime 会按需通过 `uv` 启动 Python MCP。生产时先构建 `web/dist`，再设置 `HARMONY_MASTRA_SERVE_WEB=true`，runtime 进程由 Hono 提供产品 API 和静态网页，Mastra 负责 Agent 编排及 storage 集成。具体命令以根目录 README 和 `Makefile` 为准。

迁移规格、阶段状态和验收证据见 [`mastra-runtime-migration-spec.md`](mastra-runtime-migration-spec.md)。
