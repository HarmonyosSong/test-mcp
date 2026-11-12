# Troubleshoot Odyssey

面向 HarmonyOS、iOS 和 Android 客户端问题的证据驱动诊断工作台。用户只需描述问题、版本和端信息；Runtime 会按提示词与已确认的日志事实动态绑定对应版本的只读源码快照，并生成可复核的诊断报告。

```text
React/Vite 网页 -> Mastra + Hono runtime -> 只读 MCP 能力 -> 模型供应商
                                      |
                                      +-> LibSQL 产品数据与证据状态
```

诊断能力只读，不修改业务仓库，也不执行任意 Shell 命令、构建、设备操作或 DevEco CLI。源码来自版本登记表对应的 GitLab archive，Runtime 校验登记的 commit 后在自己的数据目录物化快照，不要求用户登记仓库、选择分支或提供本地工作区。

## 功能

- 多轮对话和 SSE 流式回复；单进程 runtime 的中断状态修复与重启续聊已通过自动化和生产冒烟验证，多进程并发准入尚不支持。
- 证据账本：正向根因只能引用本轮或历史工具实际观测到的源码/日志证据；绑定固定快照时，源码证据还携带 `repository_id + resolved_commit + path`，避免跨版本混用。
- 本地 Markdown 知识库和声明式 `skills/*/SKILL.md`。
- 客户端本地 Markdown 知识库通过 Knowledge MCP 提供检索；云学习知识能力由后续 A2A 对端 Agent 提供，不在客户端直连第二套知识 MCP。
- 可选 LogCenter / Aliyun SLS 四工具：私有身份发现、用户原文目标绑定、超时取消和脱敏观察已接入共享能力会话；目标绑定且身份匹配的远程日志可携带 Runtime 观察上下文进入证据账本。上述链路已有合成 mock 测试，真实生产字段覆盖和真实学员联调尚未验收，Catalog 的 appid 查询兼容性仍需修正。
- 动态源码绑定：按平台、产品线、形态、版本和构建号选择 `version-registry/` 中已核验的 ref/commit；缺少版本时选择该范围内最新已核验构建，缺少产品线或形态且无法唯一判断时追问。
- 可选的 codebase-memory-mcp 已封装在 Repository MCP 内部，提供符号搜索、文件 outline 和调用路径候选；未配置时继续使用文本搜索，任何图结果都必须回读源码后才能成为证据。
- 正式支持 DeepSeek `deepseek-flash`；同时保留 OpenAI、通义千问、Moonshot/Kimi、智谱 GLM、火山方舟/豆包及 OpenAI-compatible 配置入口作为实验/未验收选项。可配置不等于正式支持；评估入口和口径见 [`docs/triage-feedback-and-evaluation.md`](docs/triage-feedback-and-evaluation.md)。
- 会话、仓库、快照和证据状态保存在 runtime 的 LibSQL；模型配置仍保存在 owner-only 的 `.data/model-config.json`，旧 `.data` JSON 可通过迁移命令导入。
- 知音楼网页 SSO：未登录不可用业务 API；应用挂在 `/xesapp-agent` 前缀下。设计见 [`spec/sso-login-design.md`](spec/sso-login-design.md)。
- 统一外部全栈 Agent（覆盖本项目前端、H5 和服务端）通过 Compass A2A Agent Slot 接入；Supervisor 已支持确定性调查计划、客户端 `observe → source` 门禁、固定脱敏摘要的自动协查、自动跨侧、并行调查、取消和联合报告，不要求 IT 老师理解或审批另一个 Agent。新工单没有本地 `kind=log` 观测时，即使带服务端关键词和 traceId 也先进行客户端观察。规则与实现查询在本地知识不足时可自动转外部协查，不要求本地观测或 traceId；故障诊断仍保留观测和请求关联门禁。远端结论独立保存为 `external_findings`，不进入本地证据。接入契约见 [`spec/compass-a2a-integration.md`](spec/compass-a2a-integration.md)，编排细则见 [`docs/orchestration-layer-design.md`](docs/orchestration-layer-design.md)。
- 客户端只有一个统一的 `ClientDiagnosisAgent`，HarmonyOS、iOS 和 Android 通过会话端上下文、Skill、知识排序和仓库适配处理差异；服务端或专项 Agent 通过 A2A Agent Slot 接入，Compass 是首个具体实例。
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
3. 新建会话后直接输入问题和已知 hilog/代码片段，无需预选平台、产品线、仓库或版本；Runtime 会结合提示词和已关联的 LogCenter 事实确定源码范围。
4. 需要检查代码时，Runtime 自动读取 `version-registry/`，按已确认范围绑定对应 ref 的固定 commit 快照；首次物化快照需要有效的 `HARMONY_AGENT_GITLAB_TOKEN`。
5. 等待工具步骤完成。报告会显示结论、证据原文、来源位置、已排除项和缺少的信息。

## 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HARMONY_MASTRA_HOST` | `127.0.0.1` | 监听地址 |
| `HARMONY_MASTRA_PORT` | `8000` | API/网页端口 |
| `HARMONY_MASTRA_SERVE_WEB` | `false` | 是否托管 `web/dist` |
| `HARMONY_AGENT_CORS_ORIGINS` | 本地 Vite 的 5173/5174 地址 | 允许跨源访问的来源，逗号分隔 |
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:8000` | Vite 开发服务器转发 `/api` 的 runtime 地址 |
| `HARMONY_AGENT_DATA_ROOT` | `<项目根>/.data` | 统一数据根；派生 LibSQL、snapshot、模型配置与知识归档。容器设为 `/data/troubleshoot-odyssey` 并挂持久卷（见 [`spec/data-root-persistence.md`](spec/data-root-persistence.md)） |
| `HARMONY_MASTRA_DATA_DIR` | `<data-root>/mastra` | LibSQL 数据目录；设置后优先于数据根 |
| `HARMONY_MASTRA_DATABASE_URL` | `file:<data-dir>/runtime.db` | 自定义 LibSQL URL |
| `HARMONY_MASTRA_WEB_DIST` | `web/dist` | 生产静态网页目录 |
| `HARMONY_MASTRA_PROJECT_ROOT` | 仓库根目录 | MCP 项目根目录 |
| `HARMONY_MASTRA_MCP_COMMAND` | `uv` | 启动 Python MCP 的命令 |
| `HARMONY_AGENT_CODE_INDEX_COMMAND` | 空 | 可选 codebase-memory-mcp 可执行文件路径；只由 Repository MCP 内部调用，不直接暴露给模型 |
| `HARMONY_AGENT_CODE_INDEX_CACHE` | `.data/codebase-memory` | 代码索引缓存目录，按快照复用的派生产物 |
| `HARMONY_AGENT_CODE_INDEX_MODE` | `fast` | 首版仅接受 `fast`，其他模式会明确报错 |
| `HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS` | `90` | 单次索引或查询的超时，范围 5–600 秒；首次调用包含两个操作 |
| `HARMONY_MASTRA_SKILLS_DIR` | `skills` | Skill Markdown 目录 |
| `HARMONY_MASTRA_SNAPSHOT_DIR` | `<data-root>/workspaces` | 版本登记表选中的 GitLab archive 快照目录 |
| `HARMONY_AGENT_VERSION_REGISTRY_ROOT` | `version-registry` | 多端版本登记表根目录；只加载 `verified: true` 的精确 commit 映射 |
| `HARMONY_AGENT_GITLAB_BASE_URL` | `https://git.100tal.com` | 版本快照 GitLab API 地址 |
| `HARMONY_AGENT_GITLAB_TOKEN` | 空 | GitLab API 只读 token；为空时只复用已有精确快照，禁止提交到仓库 |
| `HARMONY_AGENT_GITLAB_TIMEOUT_MS` | `30000` | GitLab commit/archive 请求超时 |
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
| `HARMONY_AGENT_MASTRA_OBSERVABILITY_CONSOLE` | `true` | Mastra 观测开关；默认按会话写入精简 JSON（见下），终端不刷 span。设 `false` 关闭 |
| `HARMONY_AGENT_MASTRA_OBSERVABILITY_DIR` | `<data-dir>/observability` | 观测文件根目录；按 `conversations/<会话ID>/` 存放 |
| `HARMONY_AGENT_MASTRA_OBSERVABILITY_PREVIEW_CHARS` | `0` | 观测正文最大字符数；`0` 表示尽量全文（硬顶约 2MB/字段）；需要截断时再设正整数 |
| `HARMONY_AGENT_LOG_CATALOG` | `runtime/contracts/log-catalog/catalog.yaml` | 日志业务目录路径 |
| `HARMONY_AGENT_LOGCENTER_APP_ID` | 空 | LogCenter 应用 ID；与 Secret 同时配置才挂载工具 |
| `HARMONY_AGENT_LOGCENTER_APP_SECRET` | 空 | LogCenter 应用密钥，只在本地配置 |
| `HARMONY_AGENT_LOGCENTER_BASE_URL` | `https://logcenter-api.tal.com/api` | 日志平台网关地址 |
| `HARMONY_AGENT_LOGCENTER_TIMEOUT_MS` | `15000` | 单次日志 HTTP 请求超时，范围 100–120000 毫秒；随诊断轮取消 |

网页设置写入 `<data-root>/model-config.json`（默认 `.data/model-config.json`），文件权限为 `0600`。容器部署见 [`spec/data-root-persistence.md`](spec/data-root-persistence.md)：只设 `HARMONY_AGENT_DATA_ROOT=/data/troubleshoot-odyssey`，由平台挂卷，勿再写相对 `.data/...` 单项。runtime 会在应用管理的会话、报告、工具摘要、SSE 和评测产物边界脱敏已配置的 API Key。默认开启官方 Mastra Observability（`Observability` + `SensitiveDataFilter`），并由按会话落盘的 exporter 写入可读 JSON：`.data/mastra/observability/conversations/<会话ID>/traces/*.json`（另有 `manifest.jsonl` 索引）。文件按「用户输入 → steps[]（每轮模型话术 + 工具入出参）→ 最终回答」组织；`processor_run` / `mapping` / `model_chunk` 视为噪音丢弃。终端默认安静（`logger: false`）。不改 knowledge JSONL/cases。需要关闭时设 `HARMONY_AGENT_MASTRA_OBSERVABILITY_CONSOLE=false`。应用异常和 CLI 错误会经过脱敏。第三方 provider 库及部署采集日志仍需在目标环境验证。环境变量配置优先于本地文件配置。模型设置中禁用模型后，聊天恢复为未配置状态。

知识 MCP 是可选能力。它不可用时 runtime 仍可启动，聊天会在没有知识工具的情况下继续。源码 MCP 只按当前会话动态解析出的固定 archive 快照启动；知识检索和源码检查需要 Python/uv 已安装，并已通过 `make setup` 安装 `mcp_server/` 依赖。

代码图索引是 Repository MCP 的可选内部后端。配置 `HARMONY_AGENT_CODE_INDEX_COMMAND` 后，仓库 MCP 会在当前快照中按需建立或复用 CBM 索引，并仅挂载 `search_code_symbols`、`get_code_outline`、`trace_code_path` 三个只读导航工具。模型不能创建、删除或指定索引；索引命中、outline 和调用边只能缩小源码范围，必须继续调用 `read_project_file`。命令未配置时不挂载扩展工具，命令不可用、索引失败或超时时会明确报错并保留文本搜索兜底。

启用时在部署环境放置 **codebase-memory-mcp 0.12.1** 二进制，并在 `.env` 填写 `HARMONY_AGENT_CODE_INDEX_COMMAND=/absolute/path/to/codebase-memory-mcp`，重启 Runtime 后生效；不需要额外配置一个 MCP 服务。索引只处理当前动态绑定快照中的代码副本，排除已知依赖目录、符号链接和超大文件；查询前后核对源码内容指纹，快照变化时拒绝旧图查询。`.data/codebase-memory` 下的 `source-views/` 和 `engine/` 分别保存源码副本与派生索引，Docker 部署应挂载持久卷；缓存可清理重建，不替代会话和证据数据的持久化。真实 HarmonyOS 工程已验证导航与源码回读，iOS/Android 的关系精度及真实诊断效果仍待验收。

LogCenter 能力：Catalog 双 source（阿里云 SLS 产品埋点 + 未来云 APM `service_id`）。AppID / AppSecret 留空即可使用其余功能；框架验收使用本机模拟 HTTP。工具为 `resolve_log_target`、`count_cloud_logs`、`search_cloud_logs`、`count_logs`、`query_logs`。不等于动态服务发现或日志证据门禁，契约见 [`日志目录与查询规格`](spec/log-catalog-query-capability.md)。

## 动态源码快照

源码流程是：

```text
用户提示词/关联日志 -> 解析端与版本 -> version-registry 选择 ref/commit -> GitLab archive -> 固定快照 -> 只读 MCP 检查
```

版本登记表使用 `version-registry/<platform>/<product-line>.yaml`，Runtime 启动时加载并只接受 `verified: true` 的 commit。Web 新建会话不要求预选端、仓库或版本：Runtime 先读取用户提示词中的显式平台、产品线、形态、版本和构建，再使用已关联 LogCenter 事实补齐上下文。未提供版本但范围已确定时，自动选择该范围内最新已核验版本/构建；上下文不足或冲突时不猜测。随后校验 GitLab commit，物化登记的 shell 与 component/config archive，生成只读组合工作区。缺映射、版本歧义、commit 不符或快照未准备均失败关闭；会话一旦绑定固定 commit，后续不会被远端分支变化影响。详细设计见 [`docs/multi-platform-version-snapshot-design.md`](docs/multi-platform-version-snapshot-design.md)。

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

设计细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`docs/orchestration-layer-design.md`](docs/orchestration-layer-design.md)。真实学员日志链验收、观察后的自动源码换绑、多端产品化和代码索引验收只看 [`docs/multi-capability-expansion-plan.md`](docs/multi-capability-expansion-plan.md)；完整文档入口见 [`docs/README.md`](docs/README.md)。
