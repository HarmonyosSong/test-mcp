# 当前系统架构

> 本文描述当前 TypeScript Runtime 的实现。后续能力只看 [multi-capability-expansion-plan.md](multi-capability-expansion-plan.md)，不再用旧 Python 迁移文档推断现状。

## 1. 运行时边界

```text
Web / 知音楼 IM / 评测
        |
        v
Hono 产品 API + SSO/local 身份 + AG-UI 兼容 SSE
        |
        v
RunAdmission + Runtime Supervisor
        |
        +-- ClientBranch: DiagnosisAgent（培优问题排查主 Agent / 本地调查）
        |     +-- CapabilitySession
        |     |     +-- 本地 Knowledge MCP
        |     |     +-- Repository MCP（固定快照或授权工作区）
        |     |     |     `-- 可选 CBM 内部适配器：符号、outline、调用候选
        |     |     `-- 可选 LogCenter Catalog/SLS 工具
        |     +-- SkillRegistry / 工具预算 / observe → source 门禁
        |     `-- EvidenceLedger + submit_diagnosis_report
        |
        `-- ServerBranch: AgentSlotRegistry
              `-- Compass Slot → A2A JSON-RPC/SSE → 统一外部全栈 Agent（前端 / H5 / 服务端）

Supervisor → 本地证据 + external_findings → 联合报告
ProductStore → LibSQL（会话、仓库、快照、调查状态和证据）
```

Mastra 负责模型与 Agent 流执行；Hono 只暴露产品定义的 REST/SSE 路由。Python 进程只提供 Knowledge/Repository MCP，不再拥有产品 Agent 或 HTTP 服务。Runtime 不提供 Shell、业务仓库写入、构建或设备操作。

## 2. 一轮调查

1. `POST /api/conversations/:id/messages` 先经过全局并发闸门和会话互斥，再持久化用户消息与 streaming 占位。初始写入失败不会留下幽灵任务；同会话并发返回 409，全局容量不足返回 429。
2. `createInvestigationPlan()` 以确定性规则生成 `local`、`server` 或 `parallel` 计划。远端计划带有 `externalScope=frontend_backend`，明确 Compass 当前承载的是统一前端、H5 和服务端 Agent；`server` 仅是旧持久化分支名。`clientSteps` 明确客户端是否执行 `observe`、`source`；计划、理由、预算和分支状态随会话保存。
3. `createRoundCapabilitySession()` 按轮创建知识、仓库和可选日志工具，统一传播 AbortSignal，检查工具冲突，并在结束时取消和逆序清理。学员身份通过 Runtime 私有内存上下文传给日志工具，不进入模型 schema。
4. 本地分支复用 `DiagnosisAgent`。故障诊断绑定源码时执行 `observe → source`：过早源码调用会被 Runtime 拒绝；目录不覆盖、空结果、身份未匹配或查询失败会降级，但不得把降级写成平台确认。
5. 本地报告通过 `submit_diagnosis_report` 和 EvidenceLedger 校验。源码读取/搜索、可追溯到用户输入的 hilog，以及目标已绑定且匹配当前学员身份的脱敏远程日志可产生观测；知识和 Catalog 永远只是线索。
6. 本地结构化结果以 `next_action.target=external` 和明确问题表达外部协查；`responsibility` 只表示当前证据的责任判断，不再兼任路由条件。规则与实现查询在本地知识不足时可转统一外部全栈 Agent，不要求源码/日志观测或 traceId；故障诊断仍要求本地观测和请求关联。满足条件后由 Runtime 自动调用，老师不需要审批或理解 Compass；预算、handoff 上限和远端结论隔离规则不变。
7. 外部调查先创建带固定脱敏摘要和 digest 的 `ExternalConsultation`，由 Runtime 按策略自动授权并在同一轮调用远端、生成联合报告。老师只看到通俗进度和结果；历史 `pending` 记录仍可通过原审批接口兼容恢复，恢复轮次重新走准入，不重复已完成的本地调查。
8. Compass 经 Agent Slot 调用，支持 Agent Card、JSON-RPC SSE、超时、取消和输出限长。远端结论写入 `external_findings`，不能进入本地 `evidence_refs`。
9. 联合阶段由培优问题排查主 Agent 根据本地报告与结构化远端结论生成 `joint_assessment`。`verified_claims` 只能引用本地账本证据，外部 task/consultation ID 不能冒充观测。
10. 工具终态和证据快照先持久化再发送 SSE；最终 completed/failed/cancelled 状态在流结束前保存。启动恢复会修复遗留 streaming，并保留可恢复的 pending 审批。

## 3. 调查计划规则

按顺序命中：

1. 用户明确限定只查客户端或只查服务端时遵守范围；只查服务端且远端可用时由 Runtime 自动协查，不再要求老师确认。
2. 未绑定仓库且没有本地证据时走 `local + ['observe']`，可进行知识问答或澄清。
3. 绑定源码的客户端计划为 `['observe','source']`。
4. 新工单即使命中服务端特征并带 traceId/requestId，只要账本没有 `kind=log` 观测，仍先 `local`。
5. 已有本地日志观测，同时满足服务端信号、请求关联标识、Compass 开关和远端预算时才可直接 `parallel`。
6. 学员编号或联系电话不是 Compass 的请求关联标识；`correlationReady` 仍只由 traceId/requestId 等请求级信息满足。
7. `reported_platform` 只作线索。目录命中、store 名称、普通业务日志、空结果和查询失败都不能生成 `observed_platform`；只有身份匹配且平台字段唯一的实际条目可以确认。

空 `search_cloud_logs` 和身份未匹配查询会进入“已尝试但未观察”的降级状态，不能据此确认平台或伪装成成功观测。

## 4. 证据与数据边界

| 内容 | 当前归属 | 能否支撑正向根因 |
| --- | --- | --- |
| 同一快照的源码读取/搜索 | `EvidenceLedger`，`kind=source` | 可以，但仍需模型说明因果 |
| 可追溯到用户输入的 hilog 解析 | `EvidenceLedger`，`kind=log` | 可以 |
| 用户消息 | `ev-user-*` 用户引用 | 只能证明报告现象，不能单独证明技术根因 |
| Knowledge MCP / Skill / Catalog | 导航与判据线索 | 不可以 |
| 关联 `search_cloud_logs` / `discover_client_sessions` 条目 | 脱敏后逐条进入 `EvidenceLedger`，携带 Runtime `observation_context` | 目标绑定且身份匹配时可以；未关联条目直接拒绝 |
| Compass / 其他远端 Agent | `external_findings` | 不能作为本地已验证观测 |
| 代码索引图节点/边 | Repository MCP 内部导航结果 | 不可以，必须回读同一快照源码 |

账本支持跨轮恢复、当前轮保护、历史容量淘汰、淘汰墓碑和相同内容重读恢复。报告引用必须逐字匹配观测；未知、过期或伪造 ID 会被拒绝，非法报告不会静默改成其他 verdict。

## 5. 仓库、版本与并发

- Git 会话绑定 detached commit 快照；本地目录会话读取允许根目录内的实时工作区。
- 仓库默认分支可编辑，保存前验证远端分支存在。已有会话和已创建快照不随默认分支变化。
- 仓库记录支持 `platform` 和 `version_map: version → {branch, expected_commit}`，保存时验证映射分支存在。Runtime 启动时加载 `version-registry/<platform>/<product-line>.yaml`，只接受已核验的精确 commit；可按已确认平台、产品线、形态、版本和构建号唯一选择映射，并只复用 commit 一致的本地有效快照。GitLab archive 物化前先校验 commit，缺映射、多个命中、构建号不明或快照未准备均失败关闭。
- 当前会话仍是单仓库、单分支、固定 commit。精确快照选择器已经实现，但观察后的轮内自动换绑尚未接入；不得回退默认分支或最新分支冒充精确版本，也不能把旧证据 retroactively 改标到新 commit。
- 单进程内不同会话可并行，各自拥有独立 run、能力会话、预算、账本和远端任务。历史 `waiting_confirmation` 暂停态释放全局运行槽位，恢复时重新准入；新的常规协查不再进入等待态。
- 多进程 lease/CAS 尚未实现，当前部署仍只支持一个 Runtime 进程。

## 6. 持久化与安全

可选 CBM 索引是绑定快照的派生产物，缓存在 `.data/codebase-memory/`：`source-views/` 保存允许代码的副本，`engine/` 保存上游索引，两者必须分开，避免 CBM 的缓存目录排除规则漏掉源码。身份绑定源码内容和引擎；每轮首次导航重新确认索引，轮内工作区变化时拒绝旧图查询。索引不进入证据账本，生产缓存复用和回收仍需部署验收。

`product_conversations` 保存消息、证据、调查计划、分支状态、协查记录、外部结论和 Slot 审计；`product_repositories` 与 `product_snapshots` 保存仓库和固定快照。`.data/knowledge-queries.jsonl` 与 `.data/knowledge-cases/` 是可重建的观测产物，不是对话事实源。

模型配置保存在 owner-only `.data/model-config.json`，不进入产品数据库。通用凭证脱敏之外，Runtime 每轮从用户明确标签构造学员隐私上下文：原始学员编号/电话只在内存中用于授权日志匹配，工具结果、事件、证据和案例归档只保留脱敏文本或本轮伪名。Compass 及其模型链路均在内网，默认外发使用用户原文与 traceId/requestId 关联信息，学员标识不伪名化、也不参与 Compass `correlationReady`。

## 7. 当前能力状态

| 能力 | 当前状态 |
| --- | --- |
| Mastra + Hono + LibSQL 主链路 | 已实现，旧 Python Agent/FastAPI 不再是运行入口 |
| Supervisor、自动跨侧、预算和取消 | 已实现并有离线/恢复测试 |
| Compass Agent Slot、自动协查和联合报告 | 已接入；真实 Compass A2A 已做过受控联调，对端按统一外部全栈 Agent 使用 |
| 多用户会话隔离与全局并发闸门 | 单进程已实现 |
| LogCenter Catalog/SLS 四工具 | 目标绑定、身份发现、脱敏和关联入账框架已实现；真实生产字段覆盖仍待验收 |
| 学员日志 → 平台确认 → 日志证据 | 合成 mock 链路已实现；真实学员与 HarmonyOS/具体业务字段尚未联调 |
| Android/iOS/HarmonyOS 精确版本快照选择 | 登记表加载、精确选择和 GitLab archive 物化能力已实现；观察后的会话自动换绑尚未接入 |
| Repository MCP 内部代码导航 | 可选挂载 `search_code_symbols`、`get_code_outline`、`trace_code_path`；未配置时保留原工具，失败时明确报错并引导文本搜索。真实鸿蒙工程的导航与回读已做冒烟验证，三端精度仍待验收 |

启动、配置和验证命令以根目录 [README.md](../README.md) 为准。
