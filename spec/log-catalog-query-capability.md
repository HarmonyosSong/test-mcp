# 日志目录与查询能力规格

> 状态：已批准实施P0/P1 实现中）  
> 日期：2026-11-06  
> 范围：Mastra TypeScript runtime（`runtime/`）内的**可选日志查询能力** + **仓内日志分类目录（Catalog）**  
> 关联：日志中心 / 云日志 skill（Cursor `logcenterskill`，协议与 API 参考）；外部知识可选挂载见 [`docs/mastra-external-knowledge.md`](../docs/mastra-external-knowledge.md)；Compass 分阶段能力见 [`compass-a2a-integration.md`](./compass-a2a-integration.md)  
> 硬约束：**仅提供能力**；不修改现有排查/取证链路；不与现有工具抢语义或改其行为；EvidenceLedger / 根因编排留给后续接入方

本文是 Troubleshoot Odyssey 中「查日志」能力的发布契约：解决**用户不知道 account / project / logstore / appid** 时，如何靠内置分类快速定位并查询。交付物是可挂载的工具 + Skill + Catalog；**不改**现有分层取证、报告校验与证据账本主流程。

---

## 1. 背景与目标

### 1.1 问题

1. 现有诊断只有用户粘贴 hilog 的 `parse_hilog`，没有远程日志平台检索。  
2. 日志平台（尤其阿里云 SLS）需要级联参数：`vendor → account → collection(Project) → topic(Logstore) → query`。账号列表无业务名，用户与 Agent 都无法从自然语言直接猜中 store。  
3. 同一 Logstore 下还有多个 `appid` 与业务事件（`pageid` / `eventid` / `eventname` / `desc` / `clickid`），需要内置分类才能「说到口语岛就查对地方」。

### 1.2 目标（本规格）

1. 在工程内维护一份**可 Git 审阅的日志分类 Catalog**（store → appid → 业务别名与匹配提示）。  
2. 在 Runtime 提供**可选**的薄查询工具（resolve + count + search），凭据来自环境变量；未配置则不挂载。  
3. 用产品内 `skills/*/SKILL.md` 规定调用顺序（先 resolve 再查），通过现有 `load_skill` + `required_tools` 门禁暴露给 Agent。  
4. MVP 覆盖已验证路径：阿里云 SLS、`pysy-front-log` 下 `prod-android` / `prod-cloudlearn` / `prod-ios` 及已梳理的 appid 分类。  
5. **能力正交**：新增工具名与 Skill 名不覆盖现有能力；未配置时零行为变化；配置后也不改排查主链路的强制步骤。

### 1.3 非目标

| 不做 | 说明 |
| --- | --- |
| 修改排查/取证链路 | **不改**诊断 prompt 主流程、证据门禁、报告校验、知识优先策略；不把「必须先查远程日志」写进主指令 |
| 与现有工具冲突 | 不改名/不劫持 `parse_hilog`、知识 MCP、仓库 MCP、外部知识工具；仅新增独立 tool 名与独立 Skill |
| 诊断编排接入 | 不规定「何时查日志 / 如何写根因」；不强制每轮挂日志工具进证据策略 |
| EvidenceLedger | 本规格不要求把远程日志登记为 `kind: log`；后续接入方另开规格 |
| 整包代理 logcenterskill CLI | 不向 Agent 暴露 accounts/collections/topics 全套级联工具面 |
| 腾讯云 CLS / 日志中心 ES 全量 | MVP 只做阿里云 SLS；接口预留 vendor，后续加 Catalog 条目与客户端分支 |
| Catalog 热更新 / 运营后台 | MVP 改 YAML + 发版/重启；不把 Catalog 写入 LibSQL 产品库 |
| 把 Cursor skill 目录拷进 `skills/` 当可执行体 | 产品 Skill 只是说明书；真能力是 Runtime tools |

---

## 2. 已锁定决策

| 项 | 决策 |
| --- | --- |
| 产品定位 | 查日志能力 = **可选、正交的数据源能力**；**仅提供能力**，具体取证链路不修改 |
| 与现有工具关系 | 并存不冲突：粘贴 hilog 仍走 `parse_hilog`；知识/仓库/外部知识行为不变；本能力未配置则完全不出现 |
| 排查链路 | **不修改**主诊断编排与 EvidenceLedger；后续同事若要接入取证，另开规格 |
| Catalog 存放 | [`runtime/contracts/log-catalog/catalog.yaml`](../runtime/contracts/log-catalog/catalog.yaml)（可进 Git） |
| Catalog 更新 | MVP：**改文件 + 发版/重启**；不接受必须热更新 |
| 密钥 | LogCenter `AppID` / `AppSecret` **仅**环境变量；Catalog **禁止**写密钥 |
| 工具形态 | 原生 Mastra `createTool`（薄封装 HTTP/API）；不把 Python CLI 当 Agent 子进程主路径 |
| Agent 行为入口 | `skills/use-log-catalog/SKILL.md` + `load_skill`；`required_tools` 门禁 |
| 解析模型 | 会话关键字 / 别名 → `resolve_log_target` 查 Catalog；多候选则澄清，禁止瞎猜 account |
| 默认云路径 | `vendor=aliyun`，已验证：`account=1743276692096170`，`collection=pysy-front-log`，`region=cn-beijing` |
| LibSQL | **不**存 Catalog；产品库继续只存会话/仓库/快照等运行态 |

---

## 3. 概念模型

```text
用户自然语言（口语岛 / uid / 最近1小时）
        │
        ▼
┌───────────────────┐
│ resolve_log_target │  ← 读 Catalog（别名、appid、业务 match 提示）
└─────────┬─────────┘
          │ 唯一命中 / 用户确认后的目标
          ▼
┌───────────────────┐
│ count_cloud_logs  │  ← 可选，先看量
│ search_cloud_logs │  ← 带 account/collection/topic/appid/query/time
└───────────────────┘
          │
          ▼
     结构化日志结果（截断、脱敏）返回给模型
```

三件套职责：

| 件 | 是什么 | 不是什么 |
| --- | --- | --- |
| **Catalog** | 业务 → 查询坐标的静态目录 | 不是会话状态，不是密钥库 |
| **Tools** | Runtime 可调用的查询手脚 | 不是 Cursor CLI，不是 MCP 全量镜像 |
| **Skill.md** | 教模型何时、按何顺序用工具 | 不是可执行脚本 |

---

## 4. Catalog 规格

### 4.1 文件位置

```text
runtime/contracts/log-catalog/
  catalog.yaml     # 权威数据
  README.md        # 维护说明（实现时补）
```

环境变量（建议名）：

| 变量 | 敏感 | 说明 |
| --- | --- | --- |
| `HARMONY_AGENT_LOG_CATALOG` | 否 | Catalog 文件路径；未设可用仓库内默认相对路径 |
| `HARMONY_AGENT_LOGCENTER_APP_ID` | 是 | 日志中心 Skill AppID |
| `HARMONY_AGENT_LOGCENTER_APP_SECRET` | 是 | 日志中心 Skill AppSecret |
| `HARMONY_AGENT_LOGCENTER_BASE_URL` | 否 | 可选；区分生产/测试网关 |

未配置 AppID/AppSecret → **不创建**日志 toolset（与外部知识「未配置不挂载」一致）。

### 4.2 Schema（逻辑字段）

顶层：

- `version`：整数，从 `1` 起  
- `vendor`：MVP 固定语义 `aliyun`（条目也可覆盖）  
- `defaults`：`region` / `account` / `collection` / `time`  
- `stores[]`：Logstore 级条目  

每个 `stores[]`：

- `id`：稳定 ID（建议与 topic 同名，如 `prod-cloudlearn`）  
- `topic`：SLS Logstore 名  
- `env`：`prod` \| `test`  
- `aliases[]`：中文/英文别名，供 resolve  
- `description`：给人与模型看的说明  
- `notes[]`：可选，如 `appid_not_sql_groupable`  
- `appids[]`：该 store 下业务线  

每个 `appids[]`：

- `id`：真实 `appid` 字符串  
- `aliases[]` / `description`  
- `key_fields[]`：拼查询时优先考虑的字段  
- `businesses[]`：可选细化  
  - `name`、`aliases[]`、`match`（如 `pageid` / `eventid` / `eventname` / `clickid`）

Resolve 规则（实现必须遵守）：

1. 用用户原文中的短连续片段或显式业务词匹配 `stores.aliases` / `appids.aliases` / `businesses.aliases`（大小写不敏感；中文精确或包含匹配策略在实现里固定并单测）。  
2. **唯一**命中 → 返回完整查询坐标 + 建议的 `query` 片段（如 `appid: "…"` 与 match 字段）。  
3. **多个**命中 → 返回候选列表，Skill 要求模型只问一个澄清问题。  
4. **零**命中 → `not_found`；不得调用 search 猜 account/topic。  
5. Catalog 未覆盖的账号级联探索：**不在 MVP 工具面**；需要扩 Catalog，而不是让 Agent 扫 57 个账号。

### 4.3 MVP 内容范围

实现首版 Catalog 必须包含会话中已验证的分类（可随评审微调文案，坐标不得臆造）：

| topic | 代表性 appid | 业务别名示例 |
| --- | --- | --- |
| `prod-android` | `log-eagle-0005-prod`, `log-fe-native-android-001-prod` | 语音测评 SDK、Android WS |
| `prod-cloudlearn` | `log-eagle-0008-prod`, `log-eagle-0009-prod`, `log-eagle-0016-prod` | 口语岛、英语绘本、磨耳朵 |
| `prod-ios` | `log-fe-native-iOS-001-prod`, `log-har-001~004-prod`, `log-fe-virtually-mall-prod` | iOS 播放器、生命周期、装扮商城 |

`prod-cloudlearn` 须标注：`appid` 不宜做 SQL `group by`；筛选用检索条件 / `where` 精确匹配。

---

## 5. 工具规格（Agent 面）

仅暴露三个工具（名称实现时可微调，但语义固定）：

### 5.1 `resolve_log_target`

**输入：** `query`（短文本，优先用户原话子串）  
**输出：**

```json
{
  "status": "resolved | ambiguous | not_found",
  "candidates": [
    {
      "store_id": "prod-cloudlearn",
      "vendor": "aliyun",
      "region": "cn-beijing",
      "account": "1743276692096170",
      "collection": "pysy-front-log",
      "topic": "prod-cloudlearn",
      "appid": "log-eagle-0008-prod",
      "business": "测评结果",
      "suggested_query": "appid: \"log-eagle-0008-prod\" and pageid: \"新口语岛\"",
      "key_fields": ["pageid", "eventid", "clickid", "uid", "customtraceid"]
    }
  ]
}
```

只读；结果**不**算观测证据（与外部知识 resolve 同类：路由信息）。

### 5.2 `count_cloud_logs`

**输入：** resolve 得到的坐标字段 + `time` + 可选 `query`  
**输出：** `{ total, elapsed_ms }`（或平台等价结构）  
大结果前应先 count（Skill 规定）。

### 5.3 `search_cloud_logs`

**输入：** 同上 + `size`（上限封顶，建议默认 ≤ 50，硬上限 ≤ 200）+ 可选 `from`  
**输出：** 截断后的日志列表（字段白名单或按 `key_fields` 优先保留）；过长 `exception`/`desc` 截断；错误码可区分权限失败 / 参数失败 / 上游失败。

**禁止**向 Agent 暴露：`cloud-accounts`、`cloud-collections`、`cloud-topics`、任意 DSL/script、未截断的全量拉取。

### 5.4 客户端实现约束

- 签名与网关调用逻辑可参考 logcenterskill，但应落在 `runtime/src/capabilities/log-center.ts`（或同级模块）内的 TypeScript 客户端，便于测试与预算包装。  
- 允许后续抽共享 Python 库，但 **Agent 默认路径不依赖** 调用本机 `~/.logcenter/credentials.json`。  
- 超时、重试、错误脱敏与外部知识适配层同级要求。

---

## 6. Skill 规格（给 Agent 的说明书）

### 6.1 文件

`skills/use-log-catalog/SKILL.md`

Frontmatter 要求：

```yaml
name: use-log-catalog
description: Resolve business log targets from the built-in catalog and query Aliyun SLS via bounded tools. Use when the user asks about remote product/app logs and log tools are available; not a substitute for pasted hilog or source evidence.
metadata:
  version: "0.1.0"
  stage: investigate
  modes: [chat]
  required_tools: [resolve_log_target, count_cloud_logs, search_cloud_logs]
```

### 6.2 行为要点（写入 Skill 正文）

1. 仅当上述三个工具可用时本 Skill 出现在可用列表。  
2. **必须**先 `load_skill("use-log-catalog")`，再 `resolve_log_target`。  
3. `ambiguous` → 一次澄清；`not_found` → 说明 Catalog 未覆盖，请用户给 store/appid 或请维护者补目录；**禁止**自行扫账号。  
4. `resolved` 后：有量不确定时先 `count_cloud_logs`，再 `search_cloud_logs`。  
5. 查询条件优先用 Catalog 的 `suggested_query` / `key_fields`；用户给了 `uid` / `customtraceid` 则并入 query。  
6. 本能力返回内容在**本规格阶段**仅作排查辅助；是否写入诊断证据账本由后续规格定义。未写入账本前，不得把「查过日志」表述成已完成的根因证明（与外部知识边界同理）。  
7. 与 `parse_hilog`：用户已粘贴 hilog 时优先本地解析；需要平台侧检索时再用本 Skill。

### 6.3 挂载方式（回答「Skill 如何提供给 Agent」）

本仓库既有机制，**无需新发明**：

1. `SkillRegistry` 扫描 `HARMONY_MASTRA_SKILLS_DIR` 下各目录的 `SKILL.md`。  
2. 每轮诊断组装 toolsets；若日志能力已配置，则合并 `resolve_log_target` 等工具。  
3. `available(mode, tools)`：仅当 `required_tools ⊆ 当前工具集` 时，该 Skill 对模型可见。  
4. Agent 内置 `load_skill`；prompt 列出当前可用 Skill 摘要。  
5. 模型按 Skill 正文顺序调工具。

因此「包装 Skill」= **新增 SKILL.md + 实现并挂载同名 required tools +（可选）prompt 一句提示**；不是安装 Cursor 插件。

---

## 7. Runtime 集成点

| 位置 | 变更 |
| --- | --- |
| `runtime/src/config.ts` | 增加 catalog 路径与 logcenter 凭据字段 |
| `runtime/src/capabilities/log-center.ts`（新） | HTTP 客户端 + createTool 包装 + Catalog 加载/resolve |
| `runtime/src/capabilities/mcp.ts` 或 `run-round.ts` | 有配置时 merge 日志 toolset（命名建议 `log_catalog`） |
| `runtime/src/diagnosis/agent.ts` | **不得**改排查主约束/证据规则。仅允许：有日志工具时追加与外部知识同级的短提示（先 load `use-log-catalog`）；预算集合纳入新工具名。若评审要求零 prompt 改动，可只靠 Skill 可见性，不做主 prompt 追加 |
| `skills/use-log-catalog/SKILL.md`（新） | 见 §6 |
| `runtime/contracts/log-catalog/*`（新） | 见 §4 |
| `.env.example` | 非敏感变量名与空密钥占位 |
| 进度文案（可选） | `progress-map` 识别日志工具名，避免一律「收集证据」 |

网页与知音楼共用 `runDiagnosisRound` 时自动共享该能力；**不为 IM 单独复制工具策略**。

---

## 8. 分阶段交付

| 阶段 | 交付物 | 说明 |
| --- | --- | --- |
| **P0 — Catalog + 客户端 + 工具** | `catalog.yaml`、config、`log-center` 客户端、三工具、单测（resolve 匹配、未配置不挂载、查询参数组装） | **本文主交付** |
| **P1 — Skill 挂载** | `use-log-catalog` + run-round 挂载 + prompt 提示 | 与 P0 可同 PR 或紧随 |
| **P2 — 诊断取证接入** | EvidenceLedger、`kind: log`、报告引用规则 | **另开规格**；本文明确不做 |
| **P3 — 扩展** | 日志中心 ES、腾讯云 CLS、更多 store 条目、热更新 | 按需 |

---

## 9. 安全与运维

- 密钥不进 Git、不进 Catalog、不进工具返回值与日志。  
- 查询结果截断；避免把完整 PII 长字段无节制回灌上下文。  
- 权限失败（如 403）原样可理解地返回，引导申请日志中心对数字员工/应用的读权限。  
- Catalog 变更走 PR 审阅；错误坐标比漏条目更危险——宁可不命中，不可指错 topic。

---

## 10. 验证计划

1. **单测：** Catalog 加载；别名 resolve（口语岛 → `prod-cloudlearn` + `log-eagle-0008-prod`）；歧义与未命中；未配置密钥时 toolset 为空。  
2. **契约/假上游：** mock 日志中心 HTTP，断言 count/search 请求含正确 account/collection/topic/time/query。  
3. **手工联调（有密钥时）：** 配置 `.env` 后，对话「查口语岛最近 15 分钟」应先 resolve 再 count/search，坐标与本文 MVP 表一致。  
4. **回归：** 不配置日志能力时，现有诊断与外部知识路径行为不变。

---

## 11. 参考：已验证现场坐标

联调抽样（2026-11-06）确认可用：

- Account：`1743276692096170`  
- Project：`pysy-front-log`  
- Region：`cn-beijing`  
- Topics：`prod-android` / `prod-cloudlearn` / `prod-ios`  
- cloudlearn 代表 appid：`log-eagle-0008-prod`（口语岛）、`0009`（绘本）、`0016`（磨耳朵）

详细事件分类以首版 `catalog.yaml` 为准，可在实现 PR 中按抽样表落盘。

---

## 12. 开放问题（实现前可关闭）

1. LogCenter 生产/测试网关 base URL 是否与现网 skill 默认一致（实现时写死可配置默认值即可）。  
2. P0 是否同步改 `progress-map`（建议做，成本低）。  

无其它阻塞项；**P2 证据账本**不阻塞 P0/P1。
