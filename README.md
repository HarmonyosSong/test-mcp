# Troubleshoot Odyssey

面向 HarmonyOS 开发问题的证据驱动诊断工作台。用户可以粘贴现象、hilog 或代码片段，也可以绑定本地工作区或 Git 仓库；系统通过只读 MCP 工具读取真实证据，并生成可复核的诊断报告。

```text
React/Vite 网页 -> Mastra + Hono runtime -> 只读 MCP 能力 -> 模型供应商
                                      |
                                      +-> LibSQL 产品数据与证据状态
```

诊断能力只读，不修改业务仓库，也不执行任意 Shell 命令、构建、设备操作或 DevEco CLI。登记 Git 仓库时，runtime 会通过 Git CLI 更新自己的 mirror 并创建 detached 快照；不会在用户工作树中切换分支或写入文件。

## 功能

- 多轮对话和 SSE 流式回复；单进程 runtime 的中断状态修复与重启续聊已通过自动化和生产冒烟验证，多进程并发准入尚不支持。
- 证据账本：正向根因只能引用本轮或历史工具实际观测到的源码/日志证据。
- 本地 Markdown 知识库和声明式 `skills/*/SKILL.md`。
- 客户端本地 Markdown 知识库通过 Knowledge MCP 提供检索；云学习知识能力由后续 A2A 对端 Agent 提供，不在客户端直连第二套知识 MCP。
- 可选 LogCenter / Aliyun SLS 日志目录与查询框架：已接入共享能力会话，支持超时和取消；真实平台联调待完成，返回日志当前仅作辅助信息，不进入证据账本。
- 本地工作区只读检查，以及 Git 分支查询和 detached Commit 快照；本地目录绑定读取实时工作区，Git 会话读取固定 Commit 快照。
- 正式支持 DeepSeek `deepseek-flash`；同时保留 OpenAI、通义千问、Moonshot/Kimi、智谱 GLM、火山方舟/豆包及 OpenAI-compatible 配置入口作为实验/未验收选项。可配置不等于正式支持，当前 provider 范围和证据见迁移规格。
- 会话、仓库、快照和证据状态保存在 runtime 的 LibSQL；模型配置仍保存在 owner-only 的 `.data/model-config.json`，旧 `.data` JSON 可通过迁移命令导入。
- 知音楼网页 SSO：未登录不可用业务 API；应用挂在 `/xesapp-agent` 前缀下。设计见 [`spec/sso-login-design.md`](spec/sso-login-design.md)。
- 云学习服务端 Agent 通过 Compass A2A 对接；当前仓库已实现 P0 客户端和配置，聊天调用尚未接入。目标流程是客户端先初筛，用户确认本次出站摘要后再咨询服务端 Agent，返回结论由客户端交叉验证，并与本地证据分开呈现。客户端保留自己的本地知识库，不直连云学习 Knowledge MCP。规划见 [`docs/multi-capability-expansion-plan.md`](docs/multi-capability-expansion-plan.md)，接入契约见 [`spec/compass-a2a-integration.md`](spec/compass-a2a-integration.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Agent 与策略 | Mastra 1.81、TypeScript、Zod |
| HTTP 与流式协议 | Hono、AG-UI 兼容 SSE |
| 数据 | LibSQL、`@mastra/libsql` |
| 能力协议 | MCP、`@mastra/mcp`、Python FastMCP 服务 |
| 网页 | React 19、TypeScript、Vite |

`agent/` 和 `server/` 只保留旧 Python Agent/FastAPI 源码与测试作为迁移参考，不再提供可安装项目或受支持运行入口；产品 Agent 与 HTTP runtime 由 `runtime/` 承载。Mastra 全量迁移验收状态见 [`docs/mastra-runtime-migration-spec.md`](docs/mastra-runtime-migration-spec.md)。

## 环境要求

- Node.js `>=22.13.0`
- npm
- Python `>=3.11` 和 uv：Mastra runtime 通过它启动 `mcp_server/` MCP 能力；仅运行网页/API 不需要 MCP，但知识检索和仓库代码检查依赖 Python/uv

## 启动网页（开发模式）

在项目根目录执行：

```bash
make setup
cp .env.example .env
```

`make setup` 会一次安装 MCP、网页和 Mastra runtime 的依赖；如果只需要先打开网页/API，可分别执行 `npm --prefix web install` 和 `npm --prefix runtime ci`，不启动 MCP 时不要求 Python/uv。

编辑 `.env`。本地开发建议 `HARMONY_AGENT_RUN_MODE=local`（免 SSO）；线上 `.env-prd` 使用 `server` 走知音楼 SSO。例如：

```dotenv
HARMONY_AGENT_MODE=model
HARMONY_AGENT_MODEL=deepseek:deepseek-flash
DEEPSEEK_API_KEY=your-api-key
HARMONY_AGENT_ALLOWED_ROOTS=/absolute/path/to/your/HarmonyOS/project

# 本地免登；线上改为 server
HARMONY_AGENT_RUN_MODE=local
# 知音楼 SSO（PUBLIC_BASE_URL 只写 origin，不含 /xesapp-agent；server 模式必填）
HARMONY_AGENT_PUBLIC_BASE_URL=https://127.0.0.1:5174
HARMONY_AGENT_APP_PREFIX=/xesapp-agent
HARMONY_AGENT_SSO_BASE_URL=https://sso.zhiyinlou.com
HARMONY_AGENT_SSO_APP_ID=your-app-id
HARMONY_AGENT_SSO_APP_KEY=your-app-key
```

本地 SSO 回调需要 HTTPS。用 mkcert 生成证书后，在 `web/.env.local`（不入库）配置：

```dotenv
VITE_DEV_HTTPS_CERT=../.certs/local.pem
VITE_DEV_HTTPS_KEY=../.certs/local-key.pem
VITE_API_PROXY_TARGET=http://127.0.0.1:8000
```

```bash
mkcert -install
mkdir -p .certs
mkcert -cert-file .certs/local.pem -key-file .certs/local-key.pem 127.0.0.1 localhost
```

平台登记回调：`{PUBLIC_BASE_URL}/xesapp-agent/auth/sso/callback`；退出回跳建议白名单：`{PUBLIC_BASE_URL}/xesapp-agent/?auth=logged-out`。

然后打开两个终端：

```bash
# 终端一：Mastra runtime，默认 http://127.0.0.1:8000
make dev-api

# 终端二：Vite 网页，默认 https://127.0.0.1:5174（配置了证书时）
make dev-web
```

浏览器访问 `https://127.0.0.1:5174/xesapp-agent/`。Vite 会把 `/xesapp-agent/api` 与 `/xesapp-agent/auth` 代理到 `127.0.0.1:8000`。`RUN_MODE=local` 时无需企业登录即可进入工作台；`server` 且未配置 SSO 时页面会提示登录配置未完成。没有模型配置时进入工作台后发送诊断消息会返回配置提示。未安装 Python/uv 时，Mastra API 仍可启动；知识 MCP 会降级为空能力，仓库代码检查不可用。

停止服务时，在对应终端按 `Ctrl+C`。

## 启动项目（生产模式）

构建网页和 runtime，并由一个 Mastra 进程同时提供网页与 API：

```bash
make start
```

访问 `http://127.0.0.1:8000/xesapp-agent/`（生产环境请把 `HARMONY_AGENT_PUBLIC_BASE_URL` 配成实际 HTTPS origin）。也可以分步执行：

```bash
make build
HARMONY_MASTRA_SERVE_WEB=true npm --prefix runtime start
```

## 第一次使用

1. 用企业账号完成知音楼 SSO 登录。
2. 在模型设置中配置供应商、模型和 API Key，或在 `.env` 中配置环境变量。
3. 新建会话，输入问题和已知 hilog/代码片段。
4. 需要检查代码时，设置 `HARMONY_AGENT_ALLOWED_ROOTS`，再绑定本地目录；或先登记 Git 仓库并选择分支。
5. 等待工具步骤完成。报告会显示结论、证据原文、来源位置、已排除项和缺少的信息。

## 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HARMONY_MASTRA_HOST` | `127.0.0.1` | 监听地址 |
| `HARMONY_MASTRA_PORT` | `8000` | API/网页端口 |
| `HARMONY_MASTRA_SERVE_WEB` | `false` | 是否托管 `web/dist` |
| `HARMONY_AGENT_CORS_ORIGINS` | 本地 Vite 的 5173/5174 地址 | 允许跨源访问的来源，逗号分隔 |
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:8000` | Vite 开发服务器转发 `/api` 的 runtime 地址 |
| `HARMONY_MASTRA_DATA_DIR` | `.data/mastra` | LibSQL 数据目录 |
| `HARMONY_MASTRA_DATABASE_URL` | `file:<data-dir>/runtime.db` | 自定义 LibSQL URL |
| `HARMONY_MASTRA_WEB_DIST` | `web/dist` | 生产静态网页目录 |
| `HARMONY_MASTRA_PROJECT_ROOT` | 仓库根目录 | MCP 项目根目录 |
| `HARMONY_AGENT_ALLOWED_ROOTS` | 仓库根目录 | 允许读取的本地目录，逗号分隔 |
| `HARMONY_MASTRA_MCP_COMMAND` | `uv` | 启动 Python MCP 的命令 |
| `HARMONY_MASTRA_SKILLS_DIR` | `skills` | Skill Markdown 目录 |
| `HARMONY_MASTRA_GIT_MIRROR_DIR` | `.data/git-mirrors` | Git mirror 目录 |
| `HARMONY_MASTRA_SNAPSHOT_DIR` | `.data/workspaces` | detached snapshot 目录 |
| `HARMONY_MASTRA_GIT_TIMEOUT_MS` | `120000` | Git 操作超时 |
| `HARMONY_AGENT_KNOWLEDGE_ROOT` | `knowledge` | 知识 MCP 根目录 |
| `HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE` | `legacy` | 知识召回模式：`legacy` 或实验性的 `v2`；`shadow` 尚未支持 |
| `HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY` | 随召回模式 | 知识正文预览策略：`legacy` 或 `ranked` |
| `HARMONY_AGENT_KNOWLEDGE_QUERY_LOG` | `.data/knowledge-queries.jsonl` | 知识查询和诊断 outcome 的 JSONL 日志 |
| `HARMONY_AGENT_KNOWLEDGE_CASES_DIR` | `.data/knowledge-cases` | 终态诊断案例归档目录 |
| `HARMONY_AGENT_MODEL` | `deepseek:deepseek-flash` | 环境模式使用的正式支持模型；其他 provider/model 仍可配置但处于实验或未验收状态 |
| `HARMONY_AGENT_MODEL_CONFIG_FILE` | `.data/model-config.json` | 本地模型配置文件 |
| `HARMONY_AGENT_RUN_MODE` | `server` | `local` 本机免登；`server` 走知音楼 SSO（生产必须） |
| `HARMONY_AGENT_PUBLIC_BASE_URL` | 空 | 浏览器 origin（不含 `/xesapp-agent`）；SSO 与 CSRF Origin 校验依赖它 |
| `HARMONY_AGENT_APP_PREFIX` | `/xesapp-agent` | 应用 path 前缀 |
| `HARMONY_AGENT_SSO_BASE_URL` | 空 | 知音楼 SSO 网关，如 `https://sso.zhiyinlou.com` |
| `HARMONY_AGENT_SSO_APP_ID` | 空 | 平台下发的应用 ID |
| `HARMONY_AGENT_SSO_APP_KEY` | 空 | 平台下发的应用密钥（禁止提交仓库） |
| `HARMONY_AGENT_LOG_CATALOG` | `runtime/contracts/log-catalog/catalog.yaml` | 日志业务目录路径 |
| `HARMONY_AGENT_LOGCENTER_APP_ID` | 空 | LogCenter 应用 ID；与 Secret 同时配置才挂载工具 |
| `HARMONY_AGENT_LOGCENTER_APP_SECRET` | 空 | LogCenter 应用密钥，只在本地配置 |
| `HARMONY_AGENT_LOGCENTER_BASE_URL` | `https://logcenter-api.tal.com/api` | 日志平台网关地址 |
| `HARMONY_AGENT_LOGCENTER_TIMEOUT_MS` | `15000` | 单次日志 HTTP 请求超时，范围 100–120000 毫秒；随诊断轮取消 |

网页设置写入 `.data/model-config.json`，文件权限为 `0600`。runtime 会在应用管理的会话、报告、工具摘要、SSE 和评测产物边界脱敏已配置的 API Key；Mastra 内部日志已关闭，应用异常和 CLI 错误会经过脱敏。第三方 provider 库及部署采集日志仍需在目标环境验证，不能据此保证所有日志都不含敏感内容。环境变量配置优先于本地文件配置。模型设置中禁用模型后，聊天恢复为未配置状态。

知识 MCP 是可选能力。它不可用时 runtime 仍可启动，聊天会在没有知识工具的情况下继续。仓库 MCP 按会话工作区启动：Git 仓库会绑定 detached Commit 快照，本地目录则读取授权根目录中的实时文件，诊断过程中工作区变化可能影响后续读取。知识检索和仓库代码检查需要 Python/uv 已安装，并已通过 `make setup` 安装 `mcp_server/` 依赖。

LogCenter 当前处于框架完成、待真实联调阶段。AppID / AppSecret 留空即可使用其余功能；框架验收使用本机模拟 HTTP，不依赖日志平台权限。后续联调时在本地 `.env` 配置上表变量，并核对 Catalog 的业务坐标、查询条件、响应格式和权限。现有三个工具是 `resolve_log_target`、`count_cloud_logs`、`search_cloud_logs`，不等于规划中的 `service_id` 服务发现或日志证据门禁，契约见 [`日志目录与查询规格`](spec/log-catalog-query-capability.md)。

## 仓库与快照

Git 仓库流程是：

```text
登记仓库 -> 查询分支 -> fetch -> 解析 Commit -> 创建 detached 快照 -> 只读 MCP 检查
```

会话创建请求携带 `repository_id` 和 `branch` 时，runtime 会自动保存快照的仓库、分支、Commit 和工作区路径。后续远端分支变化不会改变已经绑定的会话。直接绑定本地目录不创建快照，读取的是当前工作区内容。

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

默认离线测试不会访问模型供应商。`make live-eval` 使用 Mastra runtime 与当前配置的真实模型运行固定诊断数据集，结果逐轮写入 `.data/evals/latest.json`；需要有效模型凭据，调用可能产生费用。provider 明确报告额度耗尽时，评测会停止后续请求，并在产物中记录 `complete: false` 和停止原因。评测指标口径和未完成的发布门槛见 [`docs/mastra-runtime-migration-spec.md`](docs/mastra-runtime-migration-spec.md)。

人工复核诊断案例和提炼知识可运行 `npm --prefix runtime run cases -- --help` 查看命令；案例默认保存在 `.data/knowledge-cases/`。确认根因必须关联报告里实际观察到的源码或日志证据，知识提案只有通过整库校验后才会写入 `knowledge/`。流程说明见 [`docs/triage-feedback-and-evaluation.md`](docs/triage-feedback-and-evaluation.md)。

## 常见启动问题

- `uv: command not found`：安装 Python 3.11+ 与 uv，再从仓库根目录运行 `make setup`。网页和 API 可单独运行，但知识检索及仓库检查需要 MCP 依赖。
- 页面能打开但 API 请求失败：开发模式需同时运行 `make dev-api` 和 `make dev-web`；确认 API 监听 `8000`、Vite 监听 `5174`，并访问带前缀的地址 `/xesapp-agent/`。API 端口冲突时，在 `.env` 同时设置 `HARMONY_MASTRA_PORT` 和 `VITE_API_PROXY_TARGET`，例如 `8001` 与 `http://127.0.0.1:8001`。
- 提示登录配置未完成 / SSO 回调失败：检查 `HARMONY_AGENT_PUBLIC_BASE_URL`、`SSO_*` 是否配齐，本地是否启用 Vite HTTPS，以及平台回调是否登记为 `{PUBLIC_BASE_URL}/xesapp-agent/auth/sso/callback`。
- 聊天提示模型未配置：在网页模型设置中保存可用配置，或在 `.env` 中启用 `HARMONY_AGENT_MODE=model` 并配置相应 provider key。

## 目录

```text
runtime/      Mastra Agent、Hono API、LibSQL、模型配置和迁移
web/          React/Vite 工作台
mcp_server/   Python FastMCP 仓库与知识服务
knowledge/    Markdown 知识库
skills/       声明式诊断 Skill
docs/         当前架构、迁移规格、运维文档和历史设计记录
```

设计细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/mastra-runtime-migration-spec.md`](docs/mastra-runtime-migration-spec.md) 和 [`docs/multi-capability-technical-design.md`](docs/multi-capability-technical-design.md)。多能力扩展的产品规划见 [`docs/multi-capability-expansion-plan.md`](docs/multi-capability-expansion-plan.md)。
