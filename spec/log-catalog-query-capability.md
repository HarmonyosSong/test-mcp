# 日志目录与查询能力规格

> 状态：双 source Catalog（阿里云 SLS 埋点 + 未来云 APM service_id）已落地；真实联调与证据门禁仍后置。
> 日期：2026-11-11  
> 范围：Mastra TypeScript runtime（`runtime/`）内的**可选日志查询能力** + **仓内日志分类目录（Catalog）**  
> 关联：日志中心 / 云日志 skill（`logcenterskill`，协议与 API 参考）；能力框架见 [`ARCHITECTURE.md`](../docs/ARCHITECTURE.md)；Compass 分阶段能力见 [`compass-a2a-integration.md`](./compass-a2a-integration.md)
> 硬约束：**仅提供能力**；不修改现有排查/取证链路；不与现有工具抢语义或改其行为；EvidenceLedger / 根因编排留给后续接入方

本文是 Troubleshoot Odyssey 中「查日志」能力的发布契约：解决**用户不知道 account / project / logstore / appid / service_id** 时，如何靠内置分类快速定位并查询。交付物是可挂载的工具 + Skill + Catalog；**不改**现有分层取证、报告校验与证据账本主流程。

当前由 `capabilities/session.ts` 统一挂载五工具：`resolve_log_target`、`count_cloud_logs`、`search_cloud_logs`、`count_logs`、`query_logs`。日志凭证为空不影响其余功能；默认单次 HTTP 超时 15 秒（`HARMONY_AGENT_LOGCENTER_TIMEOUT_MS`）。框架测试用 mock/本机 HTTP。PII 脱敏闭环与日志证据门禁尚未实施。

---

## 1. 背景与目标

### 1.1 问题

1. 现有诊断只有用户粘贴 hilog 的 `parse_hilog`，没有远程日志平台检索。  
2. 日志平台（尤其阿里云 SLS）需要级联参数：`vendor → account → collection(Project) → topic(Logstore) → query`。账号列表无业务名，用户与 Agent 都无法从自然语言直接猜中 store。  
3. 同一 Logstore 下还有多个 `appid` 与业务事件（`pageid` / `eventid` / `eventname` / `desc` / `clickid`），需要内置分类才能「说到口语岛就查对地方」。

### 1.2 目标（本规格）

1. 维护可 Git 审阅 Catalog（v3）：`targets[]` 为 resolve 一等公民（SLS **appid** 或 APM `service_id`）；`stores[]` 仅物理坐标。  
2. Runtime 薄查询工具（resolve + SLS count/search + logcenter count/query）；业务筛选项来自 Catalog，不硬编码。  
3. Skill 规定：先 resolve，再按 `source` 分流；`load_skill` + `required_tools`。  
4. 覆盖：SLS 埋点（含 prod-ios 上鸿蒙/iOS 分 appid）；未来云四端 APM。  
5. **能力正交**：未配置时零行为变化。

### 1.3 非目标

| 不做 | 说明 |
| --- | --- |
| 修改排查/取证链路 | **不改**诊断 prompt 主流程、证据门禁、报告校验、知识优先策略；不把「必须先查远程日志」写进主指令 |
| 与现有工具冲突 | 不改名/不劫持 `parse_hilog`、知识 MCP、仓库 MCP、外部知识工具；仅新增独立 tool 名与独立 Skill |
| 诊断编排接入 | 不规定「何时查日志 / 如何写根因」；不强制每轮挂日志工具进证据策略 |
| EvidenceLedger | 本规格不要求把远程日志登记为 `kind: log`；后续接入方另开规格 |
| 整包代理 logcenterskill CLI | 不向 Agent 暴露 accounts/collections/topics 全套级联工具面 |
| 腾讯云 CLS / 动态服务发现全量 | 未来云仅 Catalog 白名单 `service_id`；不向 Agent 暴露 list/accounts 全量扫描；腾讯云 CLS 仍后置 |
| Catalog 热更新 / 运营后台 | MVP 改 YAML + 发版/重启；不把 Catalog 写入 LibSQL 产品库 |
| 把 Cursor skill 目录拷进 `skills/` 当可执行体 | 产品 Skill 只是说明书；真能力是 Runtime tools |

---

## 2. 已锁定决策

| 项 | 决策 |
| --- | --- |
| 产品定位 | 查日志能力 = **可选、正交的数据源能力**；**仅提供能力**，具体取证链路不修改 |
| 与现有工具关系 | 粘贴 hilog 仍走 `parse_hilog`；本地知识/仓库行为保持现有契约；日志能力未配置则不出现。外部前端、H5 与服务端知识和工具由 A2A 对端管理 |
| 排查链路 | **不修改**主诊断编排与 EvidenceLedger；后续同事若要接入取证，另开规格 |
| Catalog 存放 | [`runtime/contracts/log-catalog/catalog.yaml`](../runtime/contracts/log-catalog/catalog.yaml)（可进 Git） |
| Catalog 更新 | MVP：**改文件 + 发版/重启**；不接受必须热更新 |
| 密钥 | LogCenter `AppID` / `AppSecret` **仅**环境变量；Catalog **禁止**写密钥 |
| 工具形态 | 原生 Mastra `createTool`（薄封装 HTTP/API）；不把 Python CLI 当 Agent 子进程主路径 |
| Agent 行为入口 | `skills/use-log-catalog/SKILL.md` + `load_skill`；`required_tools` 门禁 |
| 解析模型 | 别名 → `resolve_log_target`；候选带 `source`/`log_kind`；多候选（含埋点 vs APM）则澄清；禁止瞎猜 account/service_id |
| 默认 SLS 路径 | `vendor=aliyun`，`account=1743276692096170`，`collection=pysy-front-log`，`region=cn-beijing` |
| 默认 APM 路径 | Catalog 四端 `service_id`；查询 `skill/search/time` 与 `skill/search`（秒级时间，`from`=页码） |
| LibSQL | **不**存 Catalog；产品库继续只存会话/仓库/快照等运行态 |

---

## 3. 概念模型

```text
用户自然语言（口语岛 / 安卓监控 / uid / 最近1小时）
        │
        ▼
┌───────────────────┐
│ resolve_log_target │  ← Catalog（别名 + source/log_kind）
└─────────┬─────────┘
          │ 唯一命中 / 用户确认后的目标
     ┌────┴────┐
     ▼         ▼
 source=     source=
 aliyun_sls  logcenter
     │         │
     ▼         ▼
 count_cloud_logs   count_logs
 search_cloud_logs  query_logs
     │         │
     └────┬────┘
          ▼
   结构化日志结果（截断）返回给模型
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
| `HARMONY_AGENT_LOGCENTER_TIMEOUT_MS` | 否 | 单次 HTTP 超时；默认 15000，范围 100–120000 毫秒 |

未配置 AppID/AppSecret → **不创建**日志 toolset（与外部知识「未配置不挂载」一致）。

### 4.2 Schema（逻辑字段）

顶层：

- `version`：整数（当前 `2`）  
- `vendor`：SLS 默认 `aliyun`（条目可覆盖）  
- `defaults`：`region` / `account` / `collection` / `time`（仅 SLS）  
- `stores[]`：目录条目  

每个 `stores[]`：

- `id`：稳定 ID  
- `source`：`aliyun_sls` \| `logcenter`  
- `log_kind`：`product_event` \| `client_apm`  
- `client_form`：可选 `phone` \| `pad` \| `h5` \| `harmony`  
- `topic`：SLS Logstore 名，或日志中心 topic（复核用）  
- `env`：`prod` \| `test`  
- `aliases[]` / `description` / `notes[]`  
- SLS：`appids[]`（至少一条）；可选覆盖 `region`/`account`/`collection`/`vendor`  
- LogCenter：必填 `service_id`；推荐 `app_clientid`、`key_fields`、`monitor_types`、`suggested_query`  

每个 SLS `appids[]`：`id`、`aliases`、`key_fields`、`businesses[].match` 同前。

Resolve 规则：

1. 匹配 store / appid / business / `app_clientid` / `service_id` 字符串别名。  
2. 唯一命中 → 返回带 `source` 的完整坐标与 `suggested_query`。  
3. 多命中（含跨 source）→ `ambiguous`，Skill 一次澄清（埋点 vs APM、Pad vs 手机等）。  
4. 零命中 → `not_found`；禁止猜 account/topic/service_id。  
5. 不向 Agent 暴露账号/服务全量列表；扩目录靠改 YAML。

### 4.3 内容范围

**阿里云 SLS（product_event）**

| topic | 代表性 appid | 别名示例 |
| --- | --- | --- |
| `prod-android` | `log-eagle-0005-prod`, `log-fe-native-android-001-prod` | 语音测评、Android WS |
| `prod-cloudlearn` | `log-eagle-0008-prod`… | 口语岛、绘本、磨耳朵 |
| `prod-ios` | `log-fe-native-iOS-001-prod`… | 播放器、装扮商城 |

**未来云 APM（client_apm）**

| service_id | store id | app_clientid |
| --- | --- | --- |
| 1116 | apm-pad-android | XesPadPyAndroid |
| 846 | apm-phone-android | XesPyAndroid |
| 1028 | apm-ipad-ios | XesPyIOSHD |
| 847 | apm-iphone-ios | XesPyIOS |

`prod-cloudlearn` 须标注：`appid` 不宜 SQL `group by`。

---

## 5. 工具规格（Agent 面）

五个工具：

### 5.1 `resolve_log_target`

**输入：** `query`  
**输出：** `status` + `candidates[]`，每项含 `source`、`log_kind`、`client_form`，以及 SLS 坐标或 `service_id`/`app_clientid`。只读，不算观测证据。

### 5.2 `count_cloud_logs` / 5.3 `search_cloud_logs`

仅用于 `source=aliyun_sls`。`search` 的 `from` 为偏移量；`size` 默认 ≤ 50、硬上限 200。

### 5.4 `count_logs` / 5.5 `query_logs`

仅用于 `source=logcenter`。入参 `service_id` + `time` + 可选 Lucene `query`。`query_logs.page` 从 **1** 起（页码）；`size` ≤ 40。上游：`skill/search/time`、`skill/search`。

**禁止**暴露：`cloud-accounts` / `collections` / `topics`、DSL/script、未截断全量拉取、动态 `list` 扫全站服务。

### 5.6 客户端实现约束

- 实现位于 `runtime/src/capabilities/log-center.ts`；不依赖本机 `~/.logcenter/credentials.json`。  
- 轮次 AbortSignal + 可配置超时；无自动重试。截断 ≠ 脱敏。

---

## 6. Skill 规格（给 Agent 的说明书）

### 6.1 文件

`skills/use-log-catalog/SKILL.md`

```yaml
name: use-log-catalog
metadata:
  version: "0.2.0"
  required_tools: [resolve_log_target, count_cloud_logs, search_cloud_logs, count_logs, query_logs]
```

### 6.2 行为要点

1. 五工具齐备时本 Skill 可见。  
2. 先 `load_skill`，再 `resolve_log_target`。  
3. `ambiguous` → 一次澄清（埋点 vs APM 等）；`not_found` → 补目录，禁止扫账号。  
4. `source=aliyun_sls` → count/search_cloud_logs；`source=logcenter` → count_logs/query_logs。  
5. 优先 Catalog `suggested_query` / `key_fields`。  
6. 本阶段结果仅排查辅助，不自动进证据账本。  
7. 已粘贴 hilog 时优先 `parse_hilog`。

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
| `runtime/src/capabilities/session.ts` | Web/IM/评测统一挂载 `log_catalog`；可选能力降级、工具冲突拒绝与每轮清理 |
| `runtime/src/capabilities/mcp.ts` | 创建本地知识、仓库 MCP 和原生日志工具，接收本轮 AbortSignal |
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
