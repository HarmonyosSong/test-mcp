# 当前系统架构

> 本文描述当前 TypeScript Runtime 的实现。2026-11-17 起诊断链路为**单 loop 去编排化架构**
>（[0004 去编排化](decisions/0004-deorchestration.md)）：模型自主决定排查路径，代码层只封装工具与横切护栏。

## 1. 运行时边界

```text
Web / 知音楼 IM / 评测
        |
        v
Hono 产品 API + SSO/local 身份 + AG-UI 兼容 SSE
        |
        v
RunAdmission（全局并发闸门 + 会话互斥）
        |
        v
runDiagnosisRound（单 loop，唯一诊断路径）
        |
        +-- DiagnosisAgent.stream（maxSteps=96，模型自主规划排查路径）
        |     +-- 内置 load_skill（SkillRegistry 按可用工具过滤技能目录）
        |     +-- RoundGuard 横切护栏：串行 dispatch / 调用与失败硬上限 /
        |     |   同签名失败禁重试 / 结果缓存 / 连续无进展只注入提醒 / 软时限关工具
        |     +-- ObservationRegistry（append-only 观测元数据，ev-ID 内容哈希）
        |     `-- FinalAnswerValidator（非空 / 无协议泄露 / ev-ID 存在性 / 判定锚点）
        |
        +-- 能力会话：Knowledge MCP / 可选 LogCenter Catalog + SLS / 可选 code_index 目录
        +-- 懒代理源码工具组（LazySourceHolder：read/search/list/parse_hilog 等 8 个代理，
        |     未绑定返回提示；双槽位 incident/compare，prepare_source 轮内热绑定快照）
        +-- prepare_source：按用户描述与已确认日志事实绑定 version-registry 只读快照；
        |     传与事故端不同的 platform 则绑定对照端快照（跨端实现对比，事故 scope 不变）
        `-- consult_compass（可选）：委派 Compass 服务端研发 Agent，预算 4 次/轮，完成态结论登记为正式观测

ProductStore → LibSQL（会话、快照、协查记录、观测元数据）
```

Mastra 负责模型与 Agent 流执行；Hono 只暴露产品定义的 REST/SSE 路由。Python 进程只提供
Knowledge/Repository/code_index MCP，不再拥有产品 Agent 或 HTTP 服务。Runtime 不提供 Shell、
业务仓库写入、构建或设备操作。

## 2. 一轮诊断

1. `POST /api/conversations/:id/messages` 先经过全局并发闸门和会话互斥，再持久化用户消息与
   streaming 占位。同会话并发返回 409，全局容量不足返回 429。
2. 轮首最佳努力绑定源码：用户显式带版本时省一轮工具往返；歧义/缺口转为 limitations 文本。
3. `createRoundCapabilitySession()` 按轮创建知识、可选日志目录与 code_index 工具，统一传播
   AbortSignal，结束时逆序清理。学员身份经 Runtime 私有内存上下文传给日志工具，不进入模型 schema。
4. 模型自主决定排查路径：知识检索（线索）→ 日志观察 / 粘贴 hilog 解析 → 需要源码时调用
   `prepare_source` 绑定快照（返回缺口说明时先查日志或追问）→ 读码取证 → 本地证据不足且指向
   服务端时 `consult_compass` 协查。技能正文（skills/）承载业务流程指引，模型按需 load_skill。
5. 软时限（默认 900s）到期后 RoundGuard 关闭全部工具并提示收尾；180s 收尾窗后硬 abort 兜底。
6. 最终回答经 FinalAnswerValidator 校验后放出：文本缓冲、打回重试 ≤2 次、仍不合格放行并记
   verdict=null。verdict 从「判定：已定位|可能定位|证据不足|工具异常」锚点解析，写入
   diagnosis_outcome 日志与知音楼标签。
7. 工具终态和观测快照先持久化再发送 SSE；completed/failed 终态在流结束前保存。
   启动恢复修复遗留 streaming；历史 waiting_confirmation 一律按中断修复（审批流已退役）。

## 3. 证据与数据边界

| 内容 | 当前归属 | 能否支撑正向根因 |
| --- | --- | --- |
| 同一快照的源码读取/搜索 | `ObservationRegistry`，`kind=source`，携带 `source_context={repository_id, resolved_commit, path}` | 可以，但仍需模型说明因果 |
| 对照端快照的源码读取/搜索（`target=compare`） | 同上注册表，`source_context` 携带对照端仓库与 commit，与事故端观测共存 | 可以（对比差异需标注两端平台与版本） |
| 可追溯到用户输入的 hilog 解析 | `ObservationRegistry`，`kind=log` | 可以 |
| 用户消息 | `ev-user-*` 用户引用 | 只能证明报告现象，不能单独证明技术根因 |
| Knowledge MCP / Skill / Catalog | 导航与判据线索 | 不可以 |
| Compass 协查完成态结论 | `ObservationRegistry`，`kind=external`，`observation_context` 携带 consultation_id | 可以（服务端事项的确信证据，与本地观测同级） |
| 代码索引图节点/边 | Repository/code_index MCP 内部导航结果 | 不可以，必须回读同一快照源码 |

注册表 append-only、无淘汰、无正文存储（500 条元数据软上限）。最终回答引用的 ev-ID 由
校验器做存在性校验；摘录真实性交给模型自律与评测。

## 4. 动态版本快照与并发

- Runtime 启动时加载 `version-registry/<platform>/<product-line>.yaml`，只接受 `verified: true`
  的 ref/commit 映射。用户不登记仓库、不选择分支、不绑定本地目录。
- `prepare_source` 与轮首预绑共用同一解析链路：明确版本按指定登记行绑定；产品线未写出但登记表
  命中唯一产品线时自动补齐；缺少版本时选择唯一范围内最新已核验构建；无法唯一确定时返回缺口
  说明，由模型决定追问或先查日志。
- GitLab archive 物化前校验登记 commit；登记的 `repos` 可包含一个 shell 和多个 component/config，
  通过安全的 `mount_path` 生成组合只读工作区。
- 源码证据的 `source_context` 由 Runtime 从会话绑定的仓库、commit 和挂载路径注入，稳定证据 ID
  也包含该身份；换版本必须重新绑定，旧源码证据不能改标到新 commit。
- 跨端对比：`prepare_source` 传与事故端不同的 `platform` 绑定对照端快照（同版本优先，未登记按
  对照平台规则回落并标注），写入会话 `compare_source` 独立字段；懒代理双槽位（incident/compare），
  源码工具以 `target` 参数路由。对照端观测按对照端仓库身份归因，与事故端观测共存于同一注册表。
- 单进程内不同会话可并行，各自拥有独立能力会话、护栏实例、注册表和远端任务。
- 多进程 lease/CAS 尚未实现，当前部署仍只支持一个 Runtime 进程。

## 5. 持久化与安全

可选 CBM 索引与 code_index 目录是动态绑定快照的派生产物，缓存在 `.data/codebase-memory/` 与
`code-index/`：索引不进入观测注册表，生产缓存复用和回收仍需部署验收。

`product_conversations` 保存消息、观测元数据快照、协查记录、外部结论和 Slot 审计；
`product_snapshots` 保存动态版本登记产生的固定快照元数据。`product_repositories` 仅为旧数据
迁移保留。`.data/knowledge-queries.jsonl` 与 `.data/knowledge-cases/` 是可重建的观测产物，
不是对话事实源；案例归档体为 steps + 注册表元数据 + messages_state。

模型配置保存在 owner-only `.data/model-config.json`，不进入产品数据库。2026-11-13 起全链路
不脱敏（用户决定，内网协作排查）：学员编号/电话/凭证在工具结果、事件、证据、案例归档和日志中
均明文保留；Runtime 每轮仍从用户明确标签构造学员标识上下文，用于日志匹配与
matched_identifiers 观测元数据。Compass 及其模型链路均在内网，外发摘要只包含用户原文和具体
协查问题。

## 6. 当前能力状态

| 能力 | 当前状态 |
| --- | --- |
| Mastra + Hono + LibSQL 主链路 | 已实现，旧 Python Agent/FastAPI 已删除 |
| 单 loop 诊断 + RoundGuard 护栏 + 最终回答校验 | 已实现并有回归测试 |
| prepare_source 轮内热绑定 / consult_compass 协查工具 | 已实现；真实 Compass A2A 已做过受控联调 |
| 多用户会话隔离与全局并发闸门 | 单进程已实现 |
| LogCenter Catalog/SLS 工具组 | 目标绑定、身份发现、观测和关联入账框架已实现；真实生产字段覆盖仍待验收 |
| 学员日志 → 平台确认 → 日志证据 | 合成 mock 链路已实现；真实学员与 HarmonyOS/具体业务字段尚未联调 |
| Android/iOS/HarmonyOS 精确版本快照选择 | 登记表加载、精确选择、GitLab archive 物化、多仓组合挂载、轮内热绑定已实现 |
| 跨端实现对比（对照端快照） | prepare_source 显式 platform + 懒代理双槽位已实现并有回归测试 |
| 代码导航（CBM + code_index 目录） | 可选挂载 `search_code_symbols`、`get_code_outline`、`trace_code_path` 与目录三工具；导航只作线索，失败回退文本搜索 |

启动、配置和验证命令以根目录 [README.md](../README.md) 为准。
