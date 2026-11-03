# Troubleshoot Odyssey

面向 HarmonyOS 开发问题的证据驱动诊断工作台。用户可以粘贴现象、hilog 或代码片段，也可以绑定本地工作区或 Git 仓库；系统通过只读 MCP 工具读取真实证据，并生成可复核的诊断报告。

```text
React/Vite 网页 -> Mastra + Hono runtime -> 只读 MCP 能力 -> 模型供应商
                                      |
                                      +-> LibSQL 产品数据与证据状态
```

当前产品是只读诊断工具，不修改业务仓库、不执行 Shell、构建、设备操作或 DevEco CLI。

## 功能

- 多轮对话、SSE 流式回复和中断后可恢复的会话状态。
- 证据账本：正向根因只能引用本轮或历史工具实际观测到的源码/日志证据。
- 本地 Markdown 知识库和声明式 `skills/*/SKILL.md`。
- 本地工作区检查、Git 分支查询和 detached Commit 快照。
- OpenAI、DeepSeek、通义千问、Moonshot/Kimi、智谱 GLM、火山方舟/豆包及 OpenAI-compatible 接口。
- 模型、会话、仓库和快照数据保存在 LibSQL；旧 `.data` JSON 可通过迁移命令导入。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Agent 与策略 | Mastra 1.81、TypeScript、Zod |
| HTTP 与流式协议 | Hono、AG-UI 兼容 SSE |
| 数据 | LibSQL、`@mastra/libsql` |
| 能力协议 | MCP、`@mastra/mcp`、Python FastMCP 服务 |
| 网页 | React 19、TypeScript、Vite |

`agent/` 和 `server/` 保留用于知识/MCP 领域服务、历史测试和评估资料；产品 Agent 与 HTTP runtime 由 `runtime/` 负责。

## 环境要求

- Node.js `>=22.13.0`
- npm
- Python `>=3.11` 和 uv，仅在启动 `mcp_server/` 时需要

## 启动网页（开发模式）

在项目根目录执行：

```bash
make setup
cp .env.example .env
```

编辑 `.env`，至少配置一个模型。例如：

```dotenv
HARMONY_AGENT_MODE=model
HARMONY_AGENT_MODEL=openai:gpt-5.2
OPENAI_API_KEY=your-api-key
HARMONY_AGENT_ALLOWED_ROOTS=/absolute/path/to/your/HarmonyOS/project
```

然后打开两个终端：

```bash
# 终端一：Mastra runtime，默认 http://127.0.0.1:8000
make dev-api

# 终端二：Vite 网页，默认 http://localhost:5174
make dev-web
```

浏览器访问 `http://localhost:5174`。Vite 会把 `/api` 请求代理到 `127.0.0.1:8000`。没有模型配置时网页仍可打开，但发送诊断消息会返回配置提示。

停止服务时，在对应终端按 `Ctrl+C`。

## 启动项目（生产模式）

构建网页和 runtime，并由一个 Mastra 进程同时提供网页与 API：

```bash
make start
```

访问 `http://127.0.0.1:8000`。也可以分步执行：

```bash
make build
HARMONY_MASTRA_SERVE_WEB=true npm --prefix runtime start
```

## 第一次使用

1. 打开网页，在模型设置中配置供应商、模型和 API Key，或在 `.env` 中配置环境变量。
2. 新建会话，输入问题和已知 hilog/代码片段。
3. 需要检查代码时，设置 `HARMONY_AGENT_ALLOWED_ROOTS`，再绑定本地目录；或先登记 Git 仓库并选择分支。
4. 等待工具步骤完成。报告会显示结论、证据原文、来源位置、已排除项和缺少的信息。

## 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HARMONY_MASTRA_HOST` | `127.0.0.1` | 监听地址 |
| `HARMONY_MASTRA_PORT` | `8000` | API/网页端口 |
| `HARMONY_MASTRA_SERVE_WEB` | `false` | 是否托管 `web/dist` |
| `HARMONY_MASTRA_DATA_DIR` | `.data/mastra` | LibSQL 数据目录 |
| `HARMONY_MASTRA_PROJECT_ROOT` | 仓库根目录 | MCP 项目根目录 |
| `HARMONY_AGENT_ALLOWED_ROOTS` | 当前工作目录 | 允许读取的本地目录，逗号分隔 |
| `HARMONY_MASTRA_MCP_COMMAND` | `uv` | 启动 Python MCP 的命令 |
| `HARMONY_AGENT_MODEL_CONFIG_FILE` | `.data/model-config.json` | 本地模型配置文件 |

网页设置写入 `.data/model-config.json`，文件权限为 `0600`。API Key 不会返回到状态接口、会话、报告、SSE 事件或日志；环境变量配置优先于本地文件配置。模型设置中禁用模型后，聊天恢复为未配置状态。

知识 MCP 是可选能力。它不可用时 runtime 仍可启动，聊天会在没有知识工具的情况下继续；仓库 MCP 在绑定仓库会话时按不可变快照单独启动。

## 仓库与快照

Git 仓库流程是：

```text
登记仓库 -> 查询分支 -> fetch -> 解析 Commit -> 创建 detached 快照 -> 只读 MCP 检查
```

会话创建请求携带 `repository_id` 和 `branch` 时，runtime 会自动保存快照的仓库、分支、Commit 和工作区路径。后续分支变化不会改变已经绑定的会话。

## 数据迁移

```bash
npm --prefix runtime run migrate -- --mode dry-run
npm --prefix runtime run migrate -- --mode apply
npm --prefix runtime run migrate -- --mode rollback --migration-id <id>
```

迁移会创建备份、保留旧 JSON、不覆盖已发生变化的目标记录，并支持重复执行返回 `no_op`。完整步骤见 [`docs/mastra-migration-operations.md`](docs/mastra-migration-operations.md)。

## 验证

```bash
make test-runtime
make test-mcp
make knowledge-validate
make lint
make build
```

配置真实模型后再运行 live evaluation；模型调用可能产生费用。默认离线测试不会访问模型供应商。

## 目录

```text
runtime/      Mastra Agent、Hono API、LibSQL、模型配置和迁移
web/          React/Vite 工作台
mcp_server/   Python FastMCP 仓库与知识服务
knowledge/    Markdown 知识库
skills/       声明式诊断 Skill
docs/         架构、迁移规格和运维文档
```

设计细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`docs/mastra-runtime-migration-spec.md`](docs/mastra-runtime-migration-spec.md)。
