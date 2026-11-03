# 架构图

## 运行时边界

```text
浏览器
  | REST + AG-UI 兼容 SSE
  v
runtime/src/server.ts
  |
runtime/src/app.ts                  MastraServer + Hono 路由
  |-- ProductStore                  LibSQL 产品数据
  |-- ModelConfiguration             provider/model/API Key 解析
  |-- DiagnosisAgent                Mastra Agent + 流事件适配
  |     |-- EvidenceLedger           证据 ID、逐字引用、报告门禁
  |     |-- SkillRegistry             Markdown SKILL.md
  |     `-- MCP toolsets              知识和仓库只读能力
  |-- RepositoryCapability            Git mirror + detached snapshot
  `-- migration/legacy.ts             JSON -> LibSQL 幂等迁移
          |
          `-- mcp_server/              Python FastMCP domain services
```

Mastra 负责 Agent 编排和 runtime 生命周期；Hono 保持现有 REST/SSE 合同；LibSQL 保存产品数据和 Mastra storage。Python 进程只承担 MCP 能力，不拥有产品 HTTP 服务或诊断 Agent。

## 一轮诊断

1. `POST /api/conversations/{id}/messages` 先落盘用户消息和 `streaming` assistant 占位，防止并发轮次绕过锁。
2. runtime 按会话快照创建仓库 MCP client，并发现可用知识 toolset。知识服务不可用时降级为空 toolset。
3. `DiagnosisAgent` 使用安全的产品级文本历史；旧框架内部消息不会直接交给 Mastra。未完成的 assistant 消息和不完整工具对不重放。
4. Mastra stream chunk 在 `diagnosis/agent.ts` 统一转换为文本、工具开始/结束、完成或失败事件。工具结果只有在实际来源工具返回后才进入 `EvidenceLedger`。
5. Hono 将内部事件转换成前端已有的 `RUN_STARTED`、`TEXT_MESSAGE_*`、`TOOL_CALL_*`、`STATE_SNAPSHOT`、`RUN_FINISHED` 和 `RUN_ERROR` SSE 事件。
6. 成功、模型错误、工具错误、取消和客户端断开都会把 assistant 从 `streaming` 更新为可恢复的终态。

## 持久化

- `product_conversations`：会话、展示消息、证据快照和安全历史。
- `product_repositories`：仓库登记信息。
- `product_snapshots`：仓库 Commit 与 detached 工作区元数据。
- `runtime_migrations`、`runtime_migration_items`、`runtime_schema`：迁移幂等、回滚和 schema 版本。

模型配置仍保存在 `.data/model-config.json`，由 runtime 以 `0600` 权限写入。凭据不进入产品数据库、SSE、报告或日志。

## 能力与安全

- RepositoryCapability 校验 URL、分支、允许根目录、真实路径和 snapshot identity；Git 不操作用户工作树。
- MCP 仓库 client 按会话创建并绑定 immutable snapshot，避免长连接切换到新分支。
- EvidenceLedger 区分用户描述、知识线索、工具观测和过期证据；正向诊断必须链接源码或日志观测。
- Skill 正文从 `skills/` 动态读取，Markdown 是唯一权威来源。
- runtime 不提供 shell、写文件、构建或设备工具。

## 部署形态

开发时 Vite 在 `5174` 提供网页，代理 API 到 runtime `8000`。生产时先构建 `web/dist`，再设置 `HARMONY_MASTRA_SERVE_WEB=true`，Mastra/Hono 单进程同时提供静态网页和 API。

迁移规格、阶段状态和验收证据见 [`mastra-runtime-migration-spec.md`](mastra-runtime-migration-spec.md)。
