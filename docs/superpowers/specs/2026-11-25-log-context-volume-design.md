# Odyssey 日志上下文体积优化

## 状态

- Spec 已落地；**Part A / Part B 已实现并通过测试**（Skill、校验、MCP 默认与 compact）。
- Part B 字段：P0/P1 已按人工反馈锁定（`currenthref` 去 token 保留；`ua` 改设备/App 摘要；`data.response` 留 code/message）。

## 目标与边界

- **目标**：降低 log-mcp 结果占用的模型上下文，覆盖单次过大与本轮多步累积。
- **叠加保留**：现有 Runtime Markdown 投影（`runtime/src/diagnosis/log-projection.ts`，换包装）与 context eviction（`runtime/src/diagnosis/context-eviction.ts`，满了清冰箱）**不回滚、不削弱职责**。
- **两期落地**：先「少进门」（Part A）；再「进门瘦身」（Part B，以字段审核表为准）。
- **样本依据**：学员编号 `184010299547` → UCenter uid `5570040`；经 logcenterskill（生产）拉取 `pysy-front-log` 云日志（`prod-ios` / `prod-cloudlearn` / `prod-evaluation`）及日志中心服务 846 / 1028 / 6846 / 1116。

对比参考（不照搬代码）：dev-agent 为「少进门（默认条数/时间窗/整包字节硬顶）+ 模型侧紧凑文本 / metadata 完整结构」；dev-agent-logs 为「小页 + 默认字段裁剪」。Odyssey 已有投影与 eviction，本方案在其前叠加少进门与默认瘦身。

## 分层

```mermaid
flowchart LR
  lessIn[少进门_默认窗条数次数]
  slimIn[进门瘦身_字段白名单]
  project[投影_保留]
  evict[eviction_保留]
  lessIn --> slimIn --> project --> evict
```

| 层 | 含义 | 本方案 |
|---|---|---|
| 少进门 | 少查、窄查（窗/条数/次数） | Part A，优先 |
| 进门瘦身 | 默认少字段 / 截断超长值 | Part B，字段表审核后 |
| 换包装 | JSON → Markdown，字段零丢弃 | 已有，保留 |
| 清冰箱 | 超预算钳制 + 外置 | 已有，保留 |

说明：投影是**格式优化**（约 -38% token），不是内容砍量；瘦身是**内容子集**。二者不同层，可叠加。

---

## Part A — 少进门（优先；不依赖字段审核）

### A1. 信息查询默认窗与扩窗

**锁定默认：直接查 3d；仅在 3d 无命中（且已双侧覆盖）后才允许写「近 3 天未登录」。**  
（线上反馈问题基本落在三天内；原「默认 7d / 近 7 天未登录」改为 3d。**不再**先查 24h 再扩窗。）

改动面：

- `skills/lookup-learner-profile/SKILL.md`
- `runtime/src/diagnosis/final-answer-validator.ts`（及相关系统提示中的 7d 硬表述 → 3d）

行为：

1. 拿到 uid 后：`search_both_logs` 或分侧查询 **默认 `time=3d`**，`query` 仍为 uid 裸数字。
2. **双侧覆盖（见 A1.1）**：可优先云日志出首轮设备线索，但**同窗内必须补齐日志中心侧**（或一次 `search_both_logs` 双侧并行）；禁止「只查云、声明已完整」或「只查中心当设备结论」。
3. 禁止未查满 **3d + 双侧** 就写「近 3 天未登录」；用户明确要求更早时可再扩窗。
4. 本轮已有设备结论时，故障排查 Skill **复用**，禁止无新条件地重复同窗双侧全量。

#### A1.1 优先云日志，如何保证另一侧也查到

用户日志分布在**云日志（SLS）与日志中心两侧**，体积优化不能变成单侧盲查。

| 策略 | 做法 |
|---|---|
| **默认推荐** | 信息查询 / 拿不准侧时：同窗一次 `search_both_logs(..., cloud={})` **双侧并行**（体积靠默认短窗、compact、条数预算控，而不是砍掉一侧） |
| **允许的「优先」** | 若先 `cloud_search` 拿设备线索，**同一轮、同一时间窗内必须再查日志中心**（`query` / 或补一次带 logcenter 的 `search_both_logs`）；两侧结果都进证据再写设备段 |
| **禁止** | 云侧有命中就跳过中心；中心有命中就跳过云；用单侧空结果写「未登录」 |
| **结论门禁** | 「近 3 天未登录」仅当：**已覆盖两侧**且时间窗为 **3d**（或用户要求的更宽窗）后仍无命中 |

要点：**优先**只表示「可先出云侧摘要」，不是「只查云」；**覆盖完整性**由 Skill + 校验器约束，与少进门（短窗/小页）正交。

### A2. 故障排查查询纪律（Skill）

改动面：`skills/query-platform-logs/SKILL.md`

- 用户给了事故时间 → **必须用该窗**，禁止擅自改成更宽/更窄的默认窗。
- 未给时间 → 默认 **3d**，并在回复中说明「未提供事故时间，已按近 3 天查询；若需更早或更窄窗请补充时间」。
- **`search_both_logs` 定位纪律（修订，避免漏查）**：
  - 广撒网仍只为定位：返回已有聚合预算，**不要用反复 search_both_logs 代替精查翻页捞全文**。
  - **不设「同轮最多 1～2 次 / 只精查 1～2 个 topic」硬顶**——该硬顶易漏查。
  - 改为**动态扩展**：先按命中相关度精查 Top 目标；若假设未证伪、线索指向其它 service/topic、或 `scanned_*`/`matched_*` 显示还有未覆盖目标，**继续扩查**，并在结论中写清已查范围。
  - 体积靠：短默认窗、默认 `full=false`、小 size、整包预算、投影/eviction；不靠「少查几个服务」赌正确率。
- 同窗连续翻页：优先缩窗或加条件后再翻；无硬性「最多 3 页」封顶（避免漏），但禁止无条件地空翻堆上下文。
- 无 uid/trace/明确事件时，禁止 `*` / 弱词大 size 精查；先追问或 `count`。

### A3. MCP 默认参数（硬闸）

改动面：`log-mcp/src/log_mcp/tools/cloudlog.py`、`log-mcp/src/log_mcp/tools/aggregate.py`（精查路径同步预算时含 `logcenter.py` 的 `query` / `cloud_search` 返回整形）。

| 项 | 现状 | 改为 |
|---|---|---|
| `cloud_search` 默认 `size` | 100 | **30** |
| `cloud_search` 默认 `full` | `True` | **`False`**（见下方「full 如何理解与可控性」） |
| 聚合 `cloud.full` 默认 | `True` | **`False`**（广撒网定位用 compact；细节靠后续精查） |
| 聚合 `per_topic_size` | 20 | **10**（少样例，不减覆盖） |
| 聚合 `max_topics` | 20 | **维持 20，不改**（避免少扫 topic 导致假阴性；体积用 full/条数/预算控） |
| 精查整包预算 | 几乎无（聚合侧已有单侧 24k / 单字段 600） | 精查对齐：单侧返回日志总字符预算 **24_000** + 单字符串 **600**；超限截断并带 `truncated` / `logs_omitted`（诚实截断，非静默） |

日志中心 `query` 每页 40 条保持；靠 Skill 翻页上限与整包预算约束。

#### `full` 如何理解与可控性

- **`full=false`（compact）**：走字段白名单 + P0 清洗/摘要（去 token 的 `currenthref`、`ua_summary` 等），单页更瘦。
- **`full=true`**：返回上游完整条目（仍受脱敏与整包 24k 预算约束），用于看 compact 里不够的细节。
- **「先 false、嫌疑行再 true」** 指调用节奏，不是 MCP 自动升格：
  1. 首查 / 广撒网 / 信息查询：不传 `full` 或显式 `false`（吃 schema 默认）。
  2. 已锁定少数 topic + 缩小 query（如 uid+事件/trace）后，若 compact 缺 stack/业务字段，再对**同一窄条件**打 `full=true`（尽量小 `size`）。
- **可控性（诚实评估）**：
  - **默认变瘦：可控**——改 MCP schema 默认 + 改掉 Skill 里「排查直接 full=true」的旧写法后，模型不传参就会走 compact。
  - **何时升 full：半可控**——靠 Skill 写清触发条件；模型仍可能偷懒一直 compact，或习惯性一直 `full=true`。
  - **对冲**：① Skill 禁止「首查就 full」；② 允许「窄条件补 full」；③ 即使一直 full，仍有 size 默认 30、整包预算、投影/eviction，不会完全失控；④ 正确率优先时宁可多一次小 size 的 full，也不要靠猜。
- **与 P0 的关系**：即使长期停在 `full=false`，`currenthref`/`ua` 也不是空白，而是清洗/摘要后仍可用，降低「必须立刻 full」的频率。

### A4. 测试（开工时）

- Skill / 校验：默认 `time=3d`；双侧覆盖后才允许「近 3 天未登录」。
- log-mcp：默认 size/full、精查预算截断与标记。

---

## 正确率影响评估（重要 · 按定稿重评）

### 结论（先说清）

**按当前定稿，预期不系统性降低排查正确率；部分项（双侧门禁、取消 topic 次数硬顶、保留 max_topics=20、href/ua/response 摘要而非一刀切丢弃）相对现状还有助于减少假阴性或误判。**

前提不变：默认收窄 + **证据不足可动态放宽**（扩窗 / 继续精查 / `full=true` / 翻页），不是写死一条瘦查询路径。  
残留风险集中在：① 默认窗 7d→3d；② compact 首包信息变瘦、依赖模型记得补 `full`；③ `data.response` 大包业务体默认不可见。

### 定稿逐项（影响 / 风险等级 / 对冲）

| 措施（定稿） | 正确率影响 | 风险 | 对冲 |
|---|---|---|---|
| 信息查询 / 故障未给时间默认 **3d**（原信息查询常 7d） | 覆盖线上多数「三天内」反馈；**3～7 天前**登录/事故可能首轮空或被写成「近 3 天未登录」 | **中**（场景有限） | 文案写「近 3 天」不夸大；用户说更早或业务需要再扩；有事故时间必须用用户窗 |
| **双侧覆盖**门禁 | 相对「只查云或只查中心」**正确率上升** | 低 | 校验器禁止单侧下「未登录」 |
| 取消「1～2 次 / 1～2 topic」硬顶 | **避免人为漏查** | 低 | 动态扩查；体积用预算控 |
| `max_topics` **维持 20** | **不减 topic 覆盖**（已否决降到 10） | 低 | — |
| 聚合 `cloud.full=false`、`per_topic_size=10` | 定位样例变少/变瘦；一般仍够判断「哪个 topic 有货」 | **低～中** | 命中后对目标 topic **精查**；可加大 `per_topic_size` |
| `cloud_search` 默认 `size=30`、`full=false` | 首包更瘦；可能缺超长 stack/未进白名单字段 | **中**（半靠 Skill） | 窄条件补 `full=true`；P0 后 href/ua 摘要仍在；`truncated` 可见 |
| 精查整包 24k + 字段 600 截断 | 极长单字段后半截不在首包 | **低～中** | 标记省略；`full`/外置/再查 |
| P0 `currenthref` **去 token 留 path+业务参** | 页面/参数线索仍在；**不伤**常见排障；去掉 token **降安全风险** | 低 | 极长再截断；要原始再 full（仍 redact） |
| P0 `ua` → **设备/App 摘要** | 端/版本/机型线索仍在；冷门 UA 细节可能丢 | **低～中** | 摘要抽不出则占位 + full；离散设备字段保留 |
| P0 `data.response` → **仅 code/message** | 接口成败仍可见；**榜单/业务大包细节默认不可见** | **中**（依赖是否靠 response 正文排障） | 需要正文时 `full=true`；多数 H5 排障靠 event/url/status 足够 |
| P1 `c`/`data` 子白名单 | 设备 pp 子集 + 事件摘要保留；嵌套噪声减少 | 低 | 缺字段再 full |
| 投影 / eviction | 不删已返回字段语义；满了可回读 | 低 | 保留 |

### 相对「一刀切丢字段」旧稿：正确率更稳的地方

- `currenthref` / `ua` / `response` 均改为 **清洗或摘要仍返回**，不是默认空白。
- 不砍 `max_topics`，不设精查 topic 数量硬顶。
- 双侧强制覆盖，减少「单侧空 → 误判未登录」。

### 仍须接受的残余风险（实现时写进 Skill）

1. **模型懒得补 `full`**：compact 下结论过早 → Skill 写清「字段不够下结论必须补 full / 扩查」，正确率优先于省 token。
2. **靠 response 业务体排障的个案**：默认只有 code/message → 必须再 full；若从未 full，可能漏业务细节（例如榜单字段异常）。
3. **3d 窗外的稀疏登录**：信息查询结论窗口缩短 → 文案与扩窗纪律必须跟上。

### 设计原则（写进实现约束）

1. **默认省体积，证据不足就放宽**——无命中/不够结论 → 扩窗、继续精查、`full=true`、翻页。
2. **禁止用体积规则否证业务结论**——不得因「只查了云 / 只用了 compact」就写未登录或根因。
3. **截断必须可见**——`truncated` / `logs_omitted`；需要细节再取。
4. **正确率优先于极限压缩**——定位与体积冲突时，允许多查；靠投影与 eviction 托底，不砍覆盖面。

---

## Part B — 进门瘦身（字段表待审核；通过后再改代码）

现状白名单：

- 云：`log-mcp/.../cloudlog.py` → `_CLOUD_COMPACT_FIELDS`
- 日志中心：`log-mcp/.../logcenter.py` → `_COMPACT_FIELDS` / `_DATA_DROP_KEYS`

**原则**：默认瘦、诊断必留列、完整可 `full=true` 补；不按频率删列；不静默丢 `level` / `traceId` 一类关键列。

### B0. 样本体积事实（uid 5570040，7d）

**云日志（full，每 topic 约 5 条）**

- `prod-ios`：大头 `currenthref`（含 **token**）≈43%、`rsd`≈24%、`ua`≈21%；三者合计常超单条 70%。
- `prod-cloudlearn`：大头 `rsd` / `ua` / `exception` / `currenthref`。
- `prod-evaluation`：大头 `rsd` / `ua` / `currenthref`；另有离散 `sn`。
- 设备线索分散在：`uid`、时间、`event*` / `desc` / `clickid`，以及 `ua` / `rsd` 文本中的 version / dv / clientType / OS（多数 topic **没有**独立 `device_id` 字段）。

**日志中心样本**

- 846 / 1028 / 1116：噪声 `@metadata` / `logsev_h` / `_id` / `__TIMESTAMP_NS__`；设备在 `c.pp.clientIdentifier` / `talDeviceID` / `ver` / `os` 等。
- 6846 H5：`data` 极大；子字段 **`data.response` 单条可达 ~53KB**；另有 `performanceResourceTiming`（已在 drop 集）。

### B1. 字段瘦身：按优先级看（推荐你只审这一节）

结合现有白名单与 uid `5570040` 样本。**P0 先做、收益最大；P1 其次；P2 可不动。**  
处理只有三种：**移出白名单（默认不返回）** / **截断或子字段裁剪** / **保留**。需要细节时一律 `full=true` 或扩查，不写死。

#### 审核结论（已确认）

- **P0**：不接受「整段不返回」一刀切；`currenthref` / `ua` 改为**清洗或摘要后仍返回**。
- **P1** 及其余建议：同意按下列方案落地。

#### P0 — 必须先做（体积炸弹；保留信息、去肥）

| 优先级 | 侧 | 字段 | 现白名单 | 处理方案（已定） | 为何优先 |
|---|---|---|---|---|---|
| P0-1 | 云 | `currenthref` | **在** | **保留字段名，清洗后返回**：去掉 query 中的 `token`（及同类敏感参数，如 `access_token`/`ticket` 若出现）；**保留 path + 其余业务参数**。清洗后若仍超长（如 >600 字）再截断并标记。`full=true` 仍可取原始（含 token 时须走既有 redact） | 体积大头 + 安全；path/业务参对排查仍有用 |
| P0-2 | 云 | `ua` | **在** | **不返回整段 UA**；compact 时改为返回 **设备/App 摘要**（优先解析 UA/`rsd` 中已有片段，并与离散字段合并去重），建议键名 `ua_summary` 或等价结构，例如：`version` / `clientType` / `OS`/`osVersion` / `model`/`dv` 前缀 / `source` 等能稳定抽出的项。抽不出时保留极短占位并允许 `full=true` 看原文 | 要设备信息，不要整段 UA |
| P0-3 | 云 | `rsd` | **已不在** | **维持不返回**；其设备信息并入 P0-2 摘要提取源 | 与 UA 重叠且更大 |
| P0-4 | 中心 | `data.response` | `data` 整包在白名单 | **不保留整段 `response` 正文**；若可解析为 JSON，**至少抽出并保留 `code` / `message`**（可写成瘦结构如 `response: {code, message}` 或并列小字段）。业务大包（如榜单 `data`）默认丢；需要全文时 `full=true`。样本 6846：~48KB 正文 → 仅留 `000000`/`成功` 量级 | 6846 单条 `response` 可达 ~48KB+ |
| P0-5 | 中心 | `data.performanceResourceTiming` / `data.rsd` | 前者已在 drop | **维持 / 补丢 `data.rsd`** | 对齐云侧 |

#### P1 — 建议做（已认可）

| 优先级 | 侧 | 字段 | 现白名单 | 处理方案 |
|---|---|---|---|---|
| P1-1 | 中心 | 顶层 `c` 整包 | **在**（整对象放行） | **不要整包**：只留 `c.monitorLogType` + `c.pp` 子集（`uid`/`clientIdentifier`/`talDeviceID`/`ver`/`vn`/`os`/`devid`/`dm`/`lt`）+ `c.jsBridgeInfo` 的 event/desc/status/exception（exception 截断） |
| P1-2 | 中心 | `data` 其它大子树 | 整包 | 除 P0 外，只留小字段：`eventid`/`traceid`/`status`/`method`/`elapsedTime`/`resourceUrl` + **`response` 的 code/message 摘要**；若含 `currenthref`，**同 P0-1 去 token** |
| P1-3 | 云/中心 | `exception` / 超长 `message` | 在 | **保留字段，值超 600 字截断并标记**（与 Part A 一致） |
| P1-4 | 云 | `__source__` | **在** | **移出**（常与 `__tag__:__client_ip__` 重复）；保留 client_ip |
| P1-5 | 中心 | `ua`（H5） | **在** | **与云 P0-2 一致**：不整段返回，改为设备/App 摘要 |

#### P2 — 可不动（体积小或已正确）

| 侧 | 字段 | 处理 |
|---|---|---|
| 云 | `__time__`/`timestamp`/`uid`/`event*`/`desc`/`clickid`/`status`/`pageid`/`appid`/`customtraceid`/`level`/`message`/`traceId` + 离散设备字段 | **保留** |
| 云 | `core`/`biztype`/`channel`/`gid`/`modelType`/`env`/`from`/`city*`/`sn` 及 APM 小字段 | **暂保留**（体积小） |
| 云 | 白名单未列的键 | 已默认不返回，无需改 |
| 中心 | `@timestamp`/`level`/`message`/`traceId`/`service_name`/`i`/`l`/`rip`/… | **保留** |
| 中心 | `@metadata`/`logsev_h`/`_id`/… | **本就不在白名单**，维持 |

#### 对照：现状白名单 / compact 逻辑要动哪些（一句话）

**云：** `currenthref` **留在白名单**，compact 时做 **去 token 清洗**；`ua` **可不留原文**，改为产出 **`ua_summary`（或写入已有离散键）**；`__source__` 移出；`rsd` 继续不进白名单但可作摘要解析输入（解析后不输出原文）。  
**中心：** `c`/`data` 走子白名单；`data.response` **改为 code/message 摘要**（非整段丢光）；`_DATA_DROP_KEYS` 含 `performanceResourceTiming`、`rsd` 等；H5 `ua` 同云做摘要；`data.currenthref` 去 token。

### B2. 详细 disposition 表（备查；不必先看）

<details>
<summary>云日志全表</summary>

| 字段 | 建议 | 理由 |
|---|---|---|
| `__time__` / `timestamp` / `uid` | **保留** | 时间与身份 |
| `eventid` / `eventname` / `desc` / `clickid` / `status` / `pageid` / `appid` / `customtraceid` | **保留** | 行为与排障主线索 |
| `level` / `message` / `traceId` / `exception` | **保留**；超长截断 | 故障正文 |
| 离散设备字段 | **保留**（有则留） | 设备段 |
| `rsd` | 已不在白名单 | 维持不输出；可作 `ua_summary` 解析源 |
| `ua` | 在 | **摘要**（P0-2），非整段 |
| `currenthref` | 在 | **去 token 后保留 path+业务参**（P0-1） |
| `__source__` | **移出**（P1） | 与 client_ip 重复 |
| `__tag__:__client_ip__` | **保留** | 网络线索 |
| 其它白名单小字段 | **暂保留** | P2 |

</details>

<details>
<summary>日志中心全表</summary>

| 字段 | 建议 | 理由 |
|---|---|---|
| 服务端核心列 | **保留** | 排障 |
| `c` | **子白名单**（P1） | 勿整包 |
| `data` | **子白名单**；`response`→**仅 code/message**；drop `rsd`/timing（P0） | 爆炸源 |
| 管线噪声 | 已不在白名单 | 维持 |
| H5 `ua` | **摘要**（同云 P0-2） | 对齐云 |

</details>

### B3. 瘦身落地方式（审核通过且开工后）

1. 更新 `_CLOUD_COMPACT_FIELDS` / `_COMPACT_FIELDS` / `_DATA_DROP_KEYS`（及必要时 `c` / `data` 子白名单逻辑）。
2. 单字符串 600 字截断对精查 compact 路径同样生效；`full=true` 仍可取完整（但仍受 Part A 整包 24k 预算约束）。
3. 用本 uid 的 fixture 做 compact 前后字节对比测试（云 + 6846/1028）。
4. **不改**投影零丢弃铁律：投影仍对「已返回字段」保真；瘦身发生在 MCP 返回之前。

---

## 实现门禁

1. **Part A**：本 Spec 确认后即可开发（Skill + MCP 默认 + 精查预算 + 测试）。
2. **Part B**：P0/P1 已按上文「审核结论」锁定；开工时按清洗/摘要方案改 compact，不整段丢弃 `currenthref`/`ua`。
3. Part A 与 Part B 均可在 Spec 确认后开工；Part A 不依赖摘要实现细节。

## 明确不做

- 不回滚投影；不关掉 eviction。
- 不用模型摘要日志正文。
- 不静默硬截断且不标记。
- 不在本任务改业务日志埋点代码（logcenterskill remediation 范围之外）。

## 建议开工顺序（确认后）

1. Part A1–A2（Skill + 校验文案）
2. Part A3–A4（MCP 默认与预算 + 测试）
3. Part B（字段审核通过后）
