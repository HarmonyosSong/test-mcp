# Troubleshoot Odyssey

面向 HarmonyOS 开发问题的证据驱动诊断工作台。用户可以粘贴现象、hilog 或代码片段，也可以绑定本地工作区或 Git 仓库；系统通过只读 MCP 工具读取真实证据，并生成可复核的诊断报告。

```text
React/Vite 网页 -> Mastra + Hono Runtime -> 能力会话 -> 模型供应商
                                      ├-> Knowledge MCP（客户端业务知识）
                                      ├-> Repository MCP（文本搜索 / 可选 CBM 导航）
                                      ├-> Log Catalog（可选 SLS / LogCenter 查询）
                                      ├-> Compass A2A（可选服务端 Agent 槽位）
                                      └-> LibSQL 产品数据与证据状态
```

诊断能力只读，不修改业务仓库，也不执行任意 Shell 命令、构建、设备操作或 DevEco CLI。登记 Git 仓库时，runtime 会通过 Git CLI 更新自己的 mirror 并创建 detached 快照；不会在用户工作树中切换分支或写入文件。

## 功能

- 多轮对话和 SSE 流式回复；单进程 runtime 的中断状态修复与重启续聊已通过自动化和生产冒烟验证，多进程并发准入尚不支持。
- 证据账本：正向根因只能引用本轮或历史工具实际观测到的源码/日志证据。
- 本地 Markdown 知识库和声明式 `skills/*/SKILL.md`。
- 客户端本地 Markdown 知识库通过 Knowledge MCP 提供检索；云学习知识能力由后续 A2A 对端 Agent 提供，不在客户端直连第二套知识 MCP。
- 可选 LogCenter / Aliyun SLS 日志目录查询：通过 Catalog 将业务名称解析为 SLS `appid` 或 LogCenter `service_id`，再按来源调用对应查询工具。当前远程查询结果主要作为排查辅助，不自动成为证据账本；真实生产字段、权限和真实学员联调尚未验收。
- 本地工作区只读检查，以及 Git 分支查询和 detached Commit 快照；本地目录绑定读取实时工作区，Git 会话读取固定 Commit 快照。
- 可选的 codebase-memory-mcp 已封装在 Repository MCP 内部，提供符号搜索、文件 outline 和调用路径候选；未配置时继续使用文本搜索，任何图结果都必须回读源码后才能成为证据。
- 正式支持 DeepSeek `deepseek-flash`；同时保留 OpenAI、通义千问、Moonshot/Kimi、智谱 GLM、火山方舟/豆包及 OpenAI-compatible 配置入口作为实验/未验收选项。可配置不等于正式支持；评估入口和口径见 [`docs/triage-feedback-and-evaluation.md`](docs/triage-feedback-and-evaluation.md)。
- 会话、仓库、快照和证据状态保存在 runtime 的 LibSQL；模型配置仍保存在 owner-only 的 `.data/model-config.json`，旧 `.data` JSON 可通过迁移命令导入。
- 知音楼网页 SSO：未登录不可用业务 API；应用挂在 `/xesapp-agent` 前缀下。设计见 [`spec/sso-login-design.md`](spec/sso-login-design.md)。
- 云学习服务端 Agent 通过 Compass A2A Agent Slot 接入；Supervisor 已支持确定性调查计划、客户端 `observe → source` 门禁、服务端外发审批、自动跨侧、并行调查、取消和联合报告。新工单没有本地 `kind=log` 观测时，即使带服务端关键词和 traceId 也先进行客户端观察。远端结论独立保存为 `external_findings`，不进入本地证据。接入契约见 [`spec/compass-a2a-integration.md`](spec/compass-a2a-integration.md)，编排细则见 [`docs/orchestration-layer-design.md`](docs/orchestration-layer-design.md)。
- 客户端只有一个统一的 `ClientDiagnosisAgent`，HarmonyOS、iOS 和 Android 通过会话端上下文、Skill、知识排序和仓库适配处理差异；服务端或专项 Agent 通过 A2A Agent Slot 接入，Compass 是首个具体实例。
- 可选知音楼 IM 渠道使用 `yach-cli` 接收私聊和群 @，复用同一套 Runtime 诊断链路并以 Markdown 回复；不使用旧 SDK bridge 或 `yach-mcp`，同一机器人长连接要求单副本运行。接入说明见 [`spec/yach-cli-channel.md`](spec/yach-cli-channel.md)。
- 技术分享版见 [`docs/architecture-sharing.html`](docs/architecture-sharing.html)，配套 Markdown 和分模块 SVG 位于 `docs/` 与 `docs/diagrams/`。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Agent 与策略 | Mastra 1.81、TypeScript、Zod |
| HTTP 与流式协议 | Hono、AG-UI 兼容 SSE |
| 数据 | LibSQL、`@mastra/libsql` |
| 能力协议 | MCP、`@mastra/mcp`、Python FastMCP 服务 |
| 网页 | React 19、TypeScript、Vite |

`agent/` 和 `server/` 只保留旧 Python Agent/FastAPI 源码与测试作为迁移参考，不再提供可安装项目或受支持运行入口；产品 Agent 与 HTTP runtime 由 `runtime/` 承载。当前架构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，全部有效文档的入口见 [`docs/README.md`](docs/README.md)。

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

# 本地免登；未配置本地证书时使用 http
HARMONY_AGENT_RUN_MODE=local
# 知音楼 SSO：改为 server，并使用 HTTPS；PUBLIC_BASE_URL 只写 origin
HARMONY_AGENT_PUBLIC_BASE_URL=http://127.0.0.1:5174
# HARMONY_AGENT_RUN_MODE=server
# HARMONY_AGENT_PUBLIC_BASE_URL=https://127.0.0.1:5174
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

平台登记回调：`{HARMONY_AGENT_PUBLIC_BASE_URL}/xesapp-agent/auth/sso/callback`；退出回跳建议白名单：`{HARMONY_AGENT_PUBLIC_BASE_URL}/xesapp-agent/?auth=logged-out`。

然后打开两个终端：

```bash
# 终端一：Mastra runtime，默认 http://127.0.0.1:8000
make dev-api

# 终端二：Vite 网页，默认 http://127.0.0.1:5174；配置证书后为 https
make dev-web
```

浏览器访问 `http://127.0.0.1:5174/xesapp-agent/`；如果配置了 mkcert，则访问 `https://127.0.0.1:5174/xesapp-agent/`。Vite 会把 `/xesapp-agent/api` 与 `/xesapp-agent/auth` 代理到 `127.0.0.1:8000`。`HARMONY_AGENT_RUN_MODE=local` 时无需企业登录即可进入工作台；`HARMONY_AGENT_RUN_MODE=server` 且未配置 SSO 时页面会提示登录配置未完成。没有模型配置时进入工作台后发送诊断消息会返回配置提示。未安装 Python/uv 时，Mastra API 仍可启动；知识 MCP 会降级为空能力，仓库代码检查不可用。

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

1. `HARMONY_AGENT_RUN_MODE=server` 时先用企业账号完成知音楼 SSO 登录；`HARMONY_AGENT_RUN_MODE=local` 可直接进入工作台。
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
| `HARMONY_AGENT_DATA_ROOT` | `<项目根>/.data` | 统一数据根；派生 LibSQL、mirror、snapshot、模型配置与知识归档。容器设为 `/data/troubleshoot-odyssey` 并挂持久卷（见 [`spec/data-root-persistence.md`](spec/data-root-persistence.md)） |
| `HARMONY_MASTRA_DATA_DIR` | `<data-root>/mastra` | LibSQL 数据目录；设置后优先于数据根 |
| `HARMONY_MASTRA_DATABASE_URL` | `file:<data-dir>/runtime.db` | 自定义 LibSQL URL |
| `HARMONY_MASTRA_WEB_DIST` | `web/dist` | 生产静态网页目录 |
| `HARMONY_MASTRA_PROJECT_ROOT` | 仓库根目录 | MCP 项目根目录 |
| `HARMONY_AGENT_ALLOWED_ROOTS` | 仓库根目录 | 允许读取的本地目录，逗号分隔 |
| `HARMONY_MASTRA_MCP_COMMAND` | `uv` | 启动 Python MCP 的命令 |
| `HARMONY_AGENT_CODE_INDEX_COMMAND` | 空 | 可选 codebase-memory-mcp 可执行文件路径；只由 Repository MCP 内部调用，不直接暴露给模型 |
| `HARMONY_AGENT_CODE_INDEX_CACHE` | `.data/codebase-memory` | 代码索引缓存目录，按快照复用的派生产物 |
| `HARMONY_AGENT_CODE_INDEX_MODE` | `fast` | 首版仅接受 `fast`，其他模式会明确报错 |
| `HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS` | `90` | 单次索引或查询的超时，范围 5–600 秒；首次调用包含两个操作 |
| `HARMONY_MASTRA_SKILLS_DIR` | `skills` | Skill Markdown 目录 |
| `HARMONY_MASTRA_GIT_MIRROR_DIR` | `<data-root>/git-mirrors` | Git mirror 目录；设置后优先于数据根 |
| `HARMONY_MASTRA_SNAPSHOT_DIR` | `<data-root>/workspaces` | detached snapshot 目录；设置后优先于数据根 |
| `HARMONY_MASTRA_GIT_TIMEOUT_MS` | `120000` | Git 操作超时 |
| `HARMONY_AGENT_KNOWLEDGE_ROOT` | `knowledge` | 知识 MCP 根目录 |
| `HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE` | `legacy` | 知识召回模式：`legacy` 或实验性的 `v2`；`shadow` 尚未支持 |
| `HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY` | 随召回模式 | 知识正文预览策略：`legacy` 或 `ranked` |
| `HARMONY_AGENT_KNOWLEDGE_QUERY_LOG` | `<data-root>/knowledge-queries.jsonl` | 知识查询和诊断 outcome 的 JSONL 日志；设置后优先于数据根 |
| `HARMONY_AGENT_KNOWLEDGE_CASES_DIR` | `<data-root>/knowledge-cases` | 终态诊断案例归档目录；设置后优先于数据根 |
| `HARMONY_AGENT_MODEL` | `deepseek:deepseek-flash` | 环境模式使用的正式支持模型；其他 provider/model 仍可配置但处于实验或未验收状态 |
| `HARMONY_AGENT_MODEL_CONFIG_FILE` | `<data-root>/model-config.json` | 本地模型配置文件；设置后优先于数据根 |
| `HARMONY_AGENT_RUN_MODE` | `server` | `local` 本机免登；`server` 走知音楼 SSO（生产必须） |
| `HARMONY_AGENT_PUBLIC_BASE_URL` | 空 | 浏览器 origin（不含 `/xesapp-agent`）；SSO 与 CSRF Origin 校验依赖它 |
| `HARMONY_AGENT_APP_PREFIX` | `/xesapp-agent` | 应用 path 前缀 |
| `HARMONY_AGENT_SSO_BASE_URL` | 空 | 知音楼 SSO 网关，如 `https://sso.zhiyinlou.com` |
| `HARMONY_AGENT_SSO_APP_ID` | 空 | 平台下发的应用 ID |
| `HARMONY_AGENT_SSO_APP_KEY` | 空 | 平台下发的应用密钥（禁止提交仓库） |
| `HARMONY_AGENT_A2A_BASE_URL` | `https://dev-agent-fz.speiyou.com` | Compass 服务端 Agent origin；不包含 `/compass` 路径 |
| `HARMONY_AGENT_A2A_CLIENT_ID` | `xesapp-agent` | A2A 客户端标识 |
| `HARMONY_AGENT_A2A_TOKEN` | 空 | A2A Token；为空时不挂载 Compass 槽位 |
| `HARMONY_AGENT_A2A_WAIT_SECONDS` | `180` | A2A 单次等待上限，范围 1–3600 秒 |
| `HARMONY_AGENT_A2A_MAX_OUTPUT_CHARS` | `12000` | 服务端结论最大字符数 |
| `HARMONY_AGENT_A2A_DEBUG_ENABLED` | `false` | 仅 `local` 模式启用本地 A2A 调试对端 |
| `HARMONY_AGENT_LOG_CATALOG` | `runtime/contracts/log-catalog/catalog.yaml` | 日志业务目录路径 |
| `HARMONY_AGENT_LOGCENTER_APP_ID` | 空 | LogCenter 应用 ID；与 Secret 同时配置才挂载工具 |
| `HARMONY_AGENT_LOGCENTER_APP_SECRET` | 空 | LogCenter 应用密钥，只在本地配置 |
| `HARMONY_AGENT_LOGCENTER_BASE_URL` | `https://logcenter-api.tal.com/api` | 日志平台网关地址 |
| `HARMONY_AGENT_LOGCENTER_TIMEOUT_MS` | `15000` | 单次日志 HTTP 请求超时，范围 100–120000 毫秒；随诊断轮取消 |
| `HARMONY_AGENT_YACH_ENABLED` | `false` | 是否启动知音楼 IM 渠道 |
| `HARMONY_AGENT_YACH_APP_KEY` / `_SECRET` | 空 | Yach 机器人凭证；只放在本地或部署环境 |
| `HARMONY_AGENT_YACH_CLI_PATH` | `yach-cli` | `yach-cli` 可执行文件路径 |
| `HARMONY_AGENT_YACH_ROBOT_ID` | 空 | 机器人备注配置，当前不参与路由 |

网页设置写入 `<data-root>/model-config.json`（默认 `.data/model-config.json`），文件权限为 `0600`。容器部署见 [`spec/data-root-persistence.md`](spec/data-root-persistence.md)：只设 `HARMONY_AGENT_DATA_ROOT=/data/troubleshoot-odyssey`，由平台挂卷，勿再写相对 `.data/...` 单项。runtime 会在应用管理的会话、报告、工具摘要、SSE 和评测产物边界脱敏已配置的 API Key；Mastra 内部日志已关闭，应用异常和 CLI 错误会经过脱敏。第三方 provider 库及部署采集日志仍需在目标环境验证，不能据此保证所有日志都不含敏感内容。环境变量配置优先于本地文件配置。模型设置中禁用模型后，聊天恢复为未配置状态。

知识 MCP 是可选能力。它不可用时 runtime 仍可启动，聊天会在没有知识工具的情况下继续。仓库 MCP 按会话工作区启动：Git 仓库会绑定 detached Commit 快照，本地目录则读取授权根目录中的实时文件，诊断过程中工作区变化可能影响后续读取。知识检索和仓库代码检查需要 Python/uv 已安装，并已通过 `make setup` 安装 `mcp_server/` 依赖。

代码图索引是 Repository MCP 的可选内部后端。配置 `HARMONY_AGENT_CODE_INDEX_COMMAND` 后，仓库 MCP 会在当前快照中按需建立或复用 CBM 索引，并仅挂载 `search_code_symbols`、`get_code_outline`、`trace_code_path` 三个只读导航工具。模型不能创建、删除或指定索引；索引命中、outline 和调用边只能缩小源码范围，必须继续调用 `read_project_file`。命令未配置时不挂载扩展工具，命令不可用、索引失败或超时时会明确报错并保留文本搜索兜底。

启用时在部署环境放置 **codebase-memory-mcp 0.12.1** 二进制，并在 `.env` 填写 `HARMONY_AGENT_CODE_INDEX_COMMAND=/absolute/path/to/codebase-memory-mcp`，重启 Runtime 后生效；不需要额外配置一个 MCP 服务。首版只索引授权工作区内的允许代码文件副本，排除已知依赖目录、符号链接和超大文件；查询前后核对源码内容指纹，轮内源码变化时拒绝旧图查询。`.data/codebase-memory` 下的 `source-views/` 和 `engine/` 分别保存源码副本与派生索引，Docker 部署应挂载持久卷；缓存可清理重建，不替代会话和证据数据的持久化。真实 HarmonyOS 工程已验证导航与源码回读，iOS/Android 的关系精度及真实诊断效果仍待验收。

LogCenter 能力：Catalog 双 source（阿里云 SLS 产品埋点 + 未来云 APM `service_id`）。AppID / AppSecret 同时配置后才挂载远程查询工具；框架验收使用本机模拟 HTTP。五个工具为 `resolve_log_target`、`count_cloud_logs`、`search_cloud_logs`、`count_logs`、`query_logs`。它不等于动态服务发现，也不把普通查询结果自动升级为日志证据；契约见 [`spec/log-catalog-query-capability.md`](spec/log-catalog-query-capability.md)。

Compass A2A 是客户端 Runtime 对云学习服务端 Agent 的可选出站槽位。客户端先执行本地观察，只有调查计划明确需要服务端、用户批准外发且满足关联条件时才发起远端任务；服务端返回内容会限长并作为 `external_findings` 保存，不能直接替代本地源码或日志证据。Token 留空时整个槽位不注册。

Yach-CLI 是 Runtime 的渠道适配层，不是模型工具。启用后 Runtime 启动 `yach-cli event consume`，把私聊或群 @ 转成普通诊断轮次；群 @ 会先读取有限的群历史，最终用 `yach-cli im send` 回复。相同机器人只允许一个实例消费长连接，避免多副本抢占事件。

## 仓库与快照

Git 仓库流程是：

```text
登记仓库 -> 查询分支 -> fetch -> 解析 Commit -> 创建 detached 快照 -> 只读 MCP 检查
```

会话创建请求携带 `repository_id` 和 `branch` 时，runtime 会自动保存快照的仓库、分支、Commit 和工作区路径。后续远端分支变化不会改变已经绑定的会话。直接绑定本地目录不创建快照，读取的是当前工作区内容。

仓库记录还支持 `platform` 和 `version_map: version → {branch, expected_commit}`；保存映射前验证分支存在。Runtime 可按已确认平台和精确版本唯一选择本地已准备的固定快照，缺映射、多映射、commit 不符或快照未准备均失败关闭，不回退默认分支。观察后的轮内自动换绑尚未接入，已有会话和旧证据仍保持原 commit。

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

默认离线测试不会访问模型供应商。`make live-eval` 使用 Mastra runtime 与当前配置的真实模型运行固定诊断数据集，结果逐轮写入 `.data/evals/latest.json`；需要有效模型凭据，调用可能产生费用。provider 明确报告额度耗尽时，评测会停止后续请求，并在产物中记录 `complete: false` 和停止原因。评测指标口径见 [`docs/triage-feedback-and-evaluation.md`](docs/triage-feedback-and-evaluation.md)。

人工复核诊断案例和提炼知识可运行 `npm --prefix runtime run cases -- --help` 查看命令；案例默认保存在 `.data/knowledge-cases/`。确认根因必须关联报告里实际观察到的源码或日志证据，知识提案只有通过整库校验后才会写入 `knowledge/`。流程说明见 [`docs/triage-feedback-and-evaluation.md`](docs/triage-feedback-and-evaluation.md)。

## 常见启动问题

- `uv: command not found`：安装 Python 3.11+ 与 uv，再从仓库根目录运行 `make setup`。网页和 API 可单独运行，但知识检索及仓库检查需要 MCP 依赖。
- 页面能打开但 API 请求失败：开发模式需同时运行 `make dev-api` 和 `make dev-web`；确认 API 监听 `8000`、Vite 监听 `5174`，并访问带前缀的地址 `/xesapp-agent/`。API 端口冲突时，在 `.env` 同时设置 `HARMONY_MASTRA_PORT` 和 `VITE_API_PROXY_TARGET`，例如 `8001` 与 `http://127.0.0.1:8001`。
- 提示登录配置未完成 / SSO 回调失败：检查 `HARMONY_AGENT_PUBLIC_BASE_URL`、`HARMONY_AGENT_SSO_*` 是否配齐，本地是否启用 Vite HTTPS，以及平台回调是否登记为 `{HARMONY_AGENT_PUBLIC_BASE_URL}/xesapp-agent/auth/sso/callback`。
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

设计细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`docs/orchestration-layer-design.md`](docs/orchestration-layer-design.md)。真实学员日志链验收、观察后的自动源码换绑、多端产品化和代码索引验收只看 [`docs/multi-capability-expansion-plan.md`](docs/multi-capability-expansion-plan.md)；完整文档入口见 [`docs/README.md`](docs/README.md)。
