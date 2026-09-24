# Harmony Triage

基于 PydanticAI 的 HarmonyOS 问题诊断助手。一条多轮对话链路：

```text
描述问题 -> 多轮排查（知识库 / 仓库 / 日志）-> 提交证据校验的诊断报告
```

当前版本不会修改项目、生成补丁、执行 Shell、构建或运行应用，也不会调用 DevEco CLI。

## 已包含

- PydanticAI `Agent` 驱动的多轮诊断对话：逐字流式回复，工具/MCP/Skill 调用以步骤卡片内联可见；
  Skill 通过 `load_skill` 工具按需显式加载。
- 诊断结论通过 `submit_diagnosis_report` 工具提交结构化 `DiagnosisReport`：提交时由 EvidenceLedger
  逐条核对证据 ID、来源、位置与实际观测原文，校验失败会把可行动的修改要求返回给模型；报告随消息
  持久化并在工作台渲染为报告卡片。
- FastMCP 只读工具层：列文件、搜文本、读文件片段、解析 hilog 文本。
- 现象知识库（`knowledge/`）与统一检索入口 `lookup_issue`；可接入云学习团队的 dev-knowledge
  外部知识 MCP（未配置则不暴露对应工具）。
- React 工作台：会话列表、多轮聊天、工具步骤、上下文用量与花费估算、诊断报告卡片。
- 证据跨轮持久化：每轮的观测证据快照随会话保存，后续轮次的报告可引用早轮证据（上限 120 条，FIFO 淘汰）。
- 每轮工具失败预算默认 10，预检、仓库、知识库与 Skill 调用共享；失败签名禁止原样重试，
  仅上游显式标记 `transient: true` 时允许重试一次。预算耗尽后停用工具，仍可输出证据缺口。
  可通过 `HARMONY_AGENT_TOOL_FAILURE_LIMIT` 调整；知识库路径为 `HARMONY_AGENT_KNOWLEDGE_ROOT`。
- 模型模式由统一入口规则选择知识定位或直接查证据，不再预先按业务词全仓搜索。
  `lookup_issue` 一次返回候选和有限知识预览；同轮相同的成功读取只返回复用提示。
  每轮总调用默认最多 30 次、连续无新增信息最多 4 次，分别由 `HARMONY_AGENT_TOOL_CALL_LIMIT`
  和 `HARMONY_AGENT_TOOL_NO_PROGRESS_LIMIT` 配置；到限后保留最终回答能力。
- 每次模型请求前压缩历史，按用户轮次保留工具调用配对和最近问答摘录。知识命中不能代替本次故障证据。
  聊天轮（含 Agent 返回失败事件）保存 `tool_usage`，包括调用、执行、复用次数、工具返回字符数、
  停止原因、模型请求数与 Agent 运行耗时。设计与评估边界见
  [Runtime 与知识检索约束](docs/decisions/0002-runtime-knowledge-budget.md)。
- 知识库每次工具调用追加一条查询日志（JSONL），默认 `.data/knowledge-queries.jsonl`，
  `HARMONY_AGENT_KNOWLEDGE_QUERY_LOG=off` 关闭。`uv run --project mcp_server
  harmony-knowledge-querylog` 输出未命中/弱命中清单，是条目建设清单的数据来源。

## 目录

```text
agent/          PydanticAI Agent、运行时、领域模型和 evals
server/         FastAPI + AG-UI/SSE 协议网关
mcp_server/     独立 FastMCP 只读仓库检查服务
web/            React/Vite 工作台和 AG-UI client
skills/         可信平台级 SKILL.md 内容
docs/           产品与技术文档
mcp.json        独立 stdio MCP 客户端配置示例
```

`agent/src/harmony_agent/skill_runtime/` 是 Skill 的加载、路由与组合机制；根目录 `skills/`
才是真正的声明式 Skill 内容。目标业务仓库中的 Skill 通过 MCP 作为不可信业务上下文读取。

## 快速启动

环境要求：Python 3.11+、`uv`、Node.js 18+。

在仓库根目录安装依赖：

```bash
make setup
```

终端一启动 API Server：

```bash
make dev-api
```

终端二启动工作台：

```bash
make dev-web
```

打开 <http://localhost:5174>。API 文档位于 <http://127.0.0.1:8000/docs>。

对话能力由模型驱动：未配置模型时（`demo` 模式）工作台会提示先完成模型设置。
服务在仓库根目录创建 `.data/conversations.json` 保存会话（含消息与诊断报告）；该文件已加入 `.gitignore`。

## 开始一次诊断

在工作台「新建会话」后直接描述问题，可粘贴日志或代码片段。助手会按需检索知识库、绑定仓库、
读取代码并逐步分析；证据充分（或你明确要求出报告）时，它通过 `submit_diagnosis_report`
提交结构化诊断报告，报告卡片内联显示在对话中。

聊天流端点（SSE，AG-UI 事件）：

```bash
curl -N -X POST http://127.0.0.1:8000/api/conversations/{conversation_id}/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"content": "登录页启动白屏，hilog 里有 TypeError: Cannot read property name"}'
```

## 接入业务仓库和分支

点击侧栏底部的“业务仓库”图标，一次性登记仓库名称和 Git 地址；也可以直接在聊天里用自然语言
（如“绑定仓库 xxx”）登记。凭据由运行 API 的机器通过 Git Credential Helper 或只读 Deploy Key
提供，不在前端输入 Token。

新建会话时选择仓库与分支，或在对话中让助手绑定。API 会执行：

```text
fetch 分支 -> 解析 Commit -> 创建 detached 快照 -> MCP 只读分析
```

会话会保存 `repository_name`、`requested_ref` 和 `resolved_commit`。分支后续发生变化不会影响
已绑定快照的会话；相同 Commit 会复用 `.data/workspaces/` 下的快照。

仓库接口：

```text
GET  /api/repositories
POST /api/repositories
GET  /api/repositories/{id}/branches
POST /api/repositories/{id}/snapshots
```

## 检查本地 HarmonyOS 项目

项目路径必须位于显式允许的根目录内。先创建本地配置：

```bash
cp .env.example .env
```

把 `.env` 中的 `HARMONY_AGENT_ALLOWED_ROOTS` 改为一个或多个绝对路径，多个路径用逗号分隔。
然后新建会话时传入该范围内的 `workspace_path`。每次文件读取都会再次解析真实路径，工作区内
指向外部的软链接也会被拒绝。

## 接入模型

推荐从工作台顶栏的“模型设置”入口配置。当前提供 OpenAI、DeepSeek、通义千问、
Moonshot/Kimi、智谱 GLM、火山方舟/豆包预设，也支持任意 OpenAI-compatible Chat
Completions 地址，以及本地 Ollama、vLLM 等无密钥服务。

前端只负责提交配置。API Key 不会写入浏览器、会话记录或接口响应，只驻留当前后端进程；
后端重启后运行时配置会清空。使用流程：

1. 选择供应商或自定义接口，确认模型名与 Base URL。
2. 填写 API Key；本地可信服务可选择“无需 API Key”。
3. 先执行“测试连接”，再“保存并启用”。
4. 若服务不兼容 `$defs`、strict 工具定义或多 system message，再启用“宽松兼容模式”。

也可以通过 `.env` 在 API 启动时启用模型：

```dotenv
HARMONY_AGENT_MODE=model
HARMONY_AGENT_MODEL=openai:gpt-5.2
OPENAI_API_KEY=your-key
```

重启 API。Model 模式会把问题描述、粘贴证据和模型选中的只读 MCP 结果发送给所配置的供应商，
启用前需确认代码与日志的数据策略。

运行时模型接口：

```text
GET    /api/model/providers
GET    /api/model/status
POST   /api/model/test
PUT    /api/model/config
DELETE /api/model/config
```

## 独立 MCP 入口

API 内的 PydanticAI Agent 使用进程内 `MCPToolset`。同一组工具也可通过标准 stdio 入口启动：

```bash
HARMONY_AGENT_MCP_WORKSPACE=/absolute/path/to/project \
  uv run --project mcp_server harmony-repository-mcp
```

可兼容 `mcp.json` 格式的客户端也可以复用仓库根目录的配置。stdio 模式下不要向 stdout 写日志，
否则会破坏 MCP JSON-RPC 消息。

## 验证

```bash
make test
make lint
make build
```

离线回归覆盖工具失败恢复、重试限制、预算隔离、多轮追问上下文传递，以及端到端的报告提交与证据校验
（脚本化模型驱动真实工具链）。真实模型的 Skill 遵循效果需另行验证；配置模型后可显式运行
（会产生模型用量）：

```bash
HARMONY_AGENT_LIVE_EVALS=1 uv run --project server pytest -q agent/evals/test_stage_zero.py -k live
```

整体分层与外部依赖见 [架构图](docs/ARCHITECTURE.md)，演进计划见 [ROADMAP](docs/ROADMAP.md)。
