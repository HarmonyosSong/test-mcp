# Troubleshoot Odyssey

面向 HarmonyOS 开发问题的证据驱动诊断工作台。

Troubleshoot Odyssey 将自然语言描述、代码仓库、hilog、知识库和大模型编排在同一条可追踪链路中：

```text
描述现象
  -> 定位相关知识与代码范围
  -> 读取日志和源码证据
  -> 多轮验证候选原因
  -> 输出带证据引用的诊断报告
```

它的目标不是让模型“猜一个答案”，而是让诊断过程可观察、可约束、可复核。

> 当前版本是只读诊断工具：不会修改业务仓库、生成补丁、执行 Shell、构建或运行 HarmonyOS 应用，也不会调用 DevEco CLI。

## 特性

- **多轮 Agent 对话**：基于 PydanticAI，支持流式回复、上下文压缩和多轮追问。
- **证据约束报告**：诊断结论必须引用运行时实际观测到的证据；知识库内容不能替代当前故障证据。
- **只读仓库检查**：支持列文件、搜索文本、读取文件片段和解析 hilog。
- **仓库快照**：按仓库分支解析 Commit，使用 detached 快照进行分析，避免会话受到后续分支变化影响。
- **知识检索**：本地 Markdown 知识库提供统一的 `lookup_issue` 入口，并记录查询日志帮助发现知识缺口。
- **Skill 机制**：通过声明式 `SKILL.md` 描述定位、取证、报告和仓库绑定流程，按需加载。
- **运行时保护**：工具失败预算、总调用上限、无进展停止、成功结果复用和跨轮证据持久化。
- **过程可见**：前端展示模型回复、工具调用步骤、耗时、上下文用量和诊断报告。
- **模型可替换**：支持 OpenAI、DeepSeek、通义千问、Moonshot/Kimi、智谱 GLM、火山方舟/豆包，以及任意 OpenAI-compatible 接口。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Agent 编排 | Python 3.11+、PydanticAI、Pydantic |
| HTTP 网关 | FastAPI、Uvicorn、AG-UI、SSE |
| 工具协议 | FastMCP、MCP |
| 知识库 | Markdown、结构化元数据、规则检索、JSONL 查询日志 |
| 前端 | React 19、TypeScript、Vite |
| UI | Arco Design、Lucide React、GSAP、自定义 CSS |
| 包管理 | Python 使用 uv，前端使用 npm |

这不是 ArkUI/ArkTS 应用工程，而是用于分析 HarmonyOS 项目的独立诊断服务。

## 架构

```text
web/
  React/Vite 工作台
      |
      | REST + AG-UI/SSE
      v
server/
  FastAPI 网关、会话管理、流式事件转换
      |
      v
agent/
  PydanticAI Agent、运行时约束、证据账本、Skill 路由
      |
      +--> mcp_server/
      |      只读仓库工具、知识库工具、hilog 解析
      |
      +--> 外部模型供应商
             OpenAI-compatible Chat Completions
```

核心目录：

```text
agent/          Agent 编排、领域模型、运行时和评估集
server/         FastAPI + AG-UI/SSE 网关
mcp_server/     FastMCP 仓库检查服务和知识库服务
web/            React/Vite 诊断工作台
knowledge/      本地现象知识和业务事实
skills/         平台级声明式 Skill
docs/           架构、决策、检索设计和评估文档
experiments/    检索质量和知识库评估实验
```

更完整的设计说明见：

- [架构图](docs/ARCHITECTURE.md)
- [运行时与知识检索约束](docs/decisions/0002-runtime-knowledge-budget.md)
- [知识库选型决策](docs/decisions/0001-knowledge-base-selection.md)
- [演进路线](docs/ROADMAP.md)

## 环境要求

- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- Node.js 18+
- npm

## 快速启动

在仓库根目录安装依赖：

```bash
make setup
```

启动 API：

```bash
make dev-api
```

另开一个终端启动前端：

```bash
make dev-web
```

然后访问：

- 工作台：<http://localhost:5174>
- API 文档：<http://127.0.0.1:8000/docs>

没有配置模型时，工作台可以打开，但聊天诊断不可用。

## 配置模型

复制配置模板：

```bash
cp .env.example .env
```

最小配置示例：

```dotenv
HARMONY_AGENT_MODE=model
HARMONY_AGENT_MODEL=openai:gpt-5.2
OPENAI_API_KEY=your-api-key
```

也可以直接在工作台的“模型设置”中配置。API Key 只保存在当前后端进程内，不写入浏览器、会话记录或接口响应；后端重启后运行时配置会清空。

支持以下模型接入方式：

- OpenAI
- DeepSeek
- 通义千问
- Moonshot/Kimi
- 智谱 GLM
- 火山方舟/豆包
- 任意 OpenAI-compatible 接口
- 本地 Ollama、vLLM 等无需公网 API Key 的服务

如果服务端不支持 `$defs`、strict 工具定义或多条 system message，可以在模型设置中启用兼容模式。

## 接入业务仓库

### 本地工作区

在 `.env` 中设置允许读取的根目录：

```dotenv
HARMONY_AGENT_ALLOWED_ROOTS=/absolute/path/to/your/HarmonyOS/project
```

多个目录使用逗号分隔。每次文件访问都会重新校验真实路径，越过允许根目录的路径和外部软链接会被拒绝。

### Git 仓库

可以在工作台中登记 Git 仓库，也可以使用仓库 API：

```text
GET  /api/repositories
POST /api/repositories
GET  /api/repositories/{id}/branches
POST /api/repositories/{id}/snapshots
```

会话绑定仓库分支时，服务端会：

```text
fetch 分支
  -> 解析目标 Commit
  -> 创建 detached 快照
  -> 通过只读 MCP 工具分析快照
```

会话会保存仓库、分支和解析后的 Commit。相同 Commit 的快照可以复用，分支后续变化不会影响已经开始的会话。

## 开始一次诊断

在工作台中创建会话后，可以直接描述问题，例如：

```text
登录页启动白屏，hilog 中出现
TypeError: Cannot read property name
```

Agent 会根据问题类型选择知识定位或直接读取代码和日志，并在需要时继续追问。证据充分后，模型通过 `submit_diagnosis_report` 提交结构化报告，报告包含：

- 诊断结论和严重程度
- 根因候选及置信度
- 证据原文、来源和位置
- 已排除项
- 已执行的检查
- 缺失信息和诊断边界

也可以直接调用 SSE 接口：

```bash
curl -N -X POST \
  http://127.0.0.1:8000/api/conversations/{conversation_id}/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"content":"登录页启动白屏，hilog 里有 TypeError: Cannot read property name"}'
```

## 独立 MCP 入口

API 内部会直接挂载 MCP Toolset。同一组仓库工具也可以通过标准 stdio MCP 入口启动：

```bash
HARMONY_AGENT_MCP_WORKSPACE=/absolute/path/to/project \
  uv run --project mcp_server harmony-repository-mcp
```

客户端配置示例见 [mcp.json](mcp.json)。stdio 模式下不要向 stdout 输出日志，否则会破坏 MCP JSON-RPC 通信。

## 开发与验证

知识库校验：

```bash
make knowledge-validate
```

运行离线测试：

```bash
make test
```

代码检查：

```bash
make lint
```

前端构建：

```bash
make build
```

配置真实模型后，可以运行 Live Eval。该命令会产生模型调用费用，不会在未配置模型时静默跳过：

```bash
HARMONY_AGENT_LIVE_EVALS=1 \
  uv run --project server pytest -q agent/evals/test_stage_zero.py -k live
```

## 数据与安全边界

- 业务仓库通过只读工具访问，不提供修改文件、执行命令或构建应用的能力。
- 本地工作区必须位于 `HARMONY_AGENT_ALLOWED_ROOTS` 明确允许的目录内。
- Git 仓库优先按 Commit 创建隔离快照。
- API Key 不写入前端、会话文件或 API 响应。
- 会话数据默认保存在 `.data/`，该目录已加入 `.gitignore`。
- 诊断日志和代码片段可能会发送给配置的模型供应商，启用模型前请确认数据合规策略。

当前版本更适合本地使用或受控内网部署。若部署到公网，仍需补充身份认证、权限隔离、TLS、速率限制、集中式持久化和审计策略。

## 项目状态

当前项目聚焦于：

- HarmonyOS 问题定位和证据链诊断
- 本地知识库检索质量
- MCP 工具边界和运行时成本控制
- 多轮诊断报告的可复核性

欢迎通过 Issue 或 Pull Request 提交问题和改进建议。
