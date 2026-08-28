# Harmony Triage

基于 PydanticAI 的 HarmonyOS 问题诊断 Agent MVP。它完成一条只读链路：

```text
描述问题 -> 定位范围 -> 排查证据 -> 输出诊断
```

当前版本不会修改项目、生成补丁、执行 Shell、构建或运行应用，也不会调用 DevEco CLI。

## 已包含

- PydanticAI `Agent` 与固定 `DiagnosisReport` 结构化输出。
- 三个标准、版本化的 `skills/*/SKILL.md`，分别负责定位、排查和报告。
- FastMCP 只读工具层：列文件、搜文本、读文件片段、解析 hilog 文本。
- FastAPI 异步诊断 API、四阶段进度、本地 JSON 案例记录和 Markdown/JSON 导出。
- React 可视化工作台：案例队列、新建诊断、阶段状态、证据和诊断报告。
- 多轮聊天（工作台「聊天」页）：逐字流式回复，工具/MCP/Skill 调用以步骤卡片内联可见；
  Skill 通过 `load_skill` 工具按需显式加载。聊天要求先配置模型（demo 模式不提供对话能力），
  会话持久化到 `.data/conversations.json`，可一键「生成诊断案例」（模型提取草稿 ->
  用户确认 -> 进入现有四阶段诊断）。
- 无密钥可运行的 `demo` 模式，以及接入模型供应商的 `model` 模式。

## 目录

```text
agent/          PydanticAI Agent、编排、运行时、领域模型和 evals
server/         FastAPI + AG-UI/SSE 协议网关
mcp_server/     独立 FastMCP 只读仓库检查服务
web/            React/Vite 工作台和 AG-UI reducer/client
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

终端一启动 AG-UI/REST Server：

```bash
make dev-api
```

终端二启动工作台：

```bash
make dev-web
```

打开 <http://localhost:5173>。API 文档位于 <http://127.0.0.1:8000/docs>。

默认是确定性的 `demo` 模式，不需要 API Key。服务会在仓库根目录创建
`.data/cases.json` 保存本地案例；该文件已加入 `.gitignore`。

## 提交一个诊断

工作台可直接新建案例，也可以调用 API：

```bash
curl -X POST http://127.0.0.1:8000/api/cases \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "登录页启动白屏",
    "description": "启动后白屏并抛出 TypeError",
    "evidence": "TypeError: Cannot read property name at LoginPage.ets:42"
  }'
```

工作台优先调用 `POST /api/agui/runs`，实时消费阶段、MCP 工具和状态快照事件。REST
`POST /api/cases` 与查询接口继续保留，用于兼容和非流式客户端。

## 接入业务仓库和分支

点击侧栏底部的“业务仓库”图标，一次性登记仓库名称和 Git 地址。凭据由运行 API 的机器通过
Git Credential Helper 或只读 Deploy Key 提供，不在前端输入 Token。

新建诊断时选择“业务仓库”和分支。API 会执行：

```text
fetch 分支 -> 解析 Commit -> 创建 detached 快照 -> MCP 只读分析
```

案例会保存 `repository_name`、`requested_ref` 和 `resolved_commit`。分支后续发生变化也不会影响
已经开始的诊断；相同 Commit 会复用 `.data/workspaces/` 下的快照。

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
然后在新建案例时传入该范围内的 `workspace_path`。每次文件读取都会再次解析真实路径，工作区内
指向外部的软链接也会被拒绝。

## 接入模型

推荐从工作台顶栏的“模型设置”入口配置。当前提供 OpenAI、DeepSeek、通义千问、
Moonshot/Kimi、智谱 GLM、火山方舟/豆包预设，也支持任意 OpenAI-compatible Chat
Completions 地址，以及本地 Ollama、vLLM 等无密钥服务。

前端只负责提交配置。API Key 不会写入浏览器、本地案例或接口响应，只驻留当前后端进程；
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

产品范围见 [产品需求文档](docs/PRODUCT.md)，实现与接口见 [技术设计](docs/TECHNICAL.md)。
