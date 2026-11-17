# 日志查询 MCP 服务设计方案

> 状态：待评审
> 日期：2026-11-17
> 范围：新建独立服务 `troubleshoot-odyssey/log-mcp/`，仅完成日志查询能力开发
> 不改动：`troubleshoot-odyssey` 的 catalog、agent 编排、证据链路
> 参考：`dev-agent`（进程管理与服务编排）、`dev-agent-logs`（工具实现）、`logcenterskill`（能力面基准）

## 1. 目标

提供一个**独立运行、可被任意 Agent 调用**的日志查询 MCP 服务。

- 唯一职责：把日志取回来。
- 不承载任何调用方的业务语义。
- 独立部署脚本。

## 2. 边界原则

> **MCP 负责「物理世界」，调用方负责「业务语义」。**

| 归 MCP | 归调用方 |
| --- | --- |
| 签名、HTTP、时间解析 | 学员 uid / 手机号 / traceId |
| 服务发现、字段、存储类型 | 业务名 → appid 映射 |
| count / query / DSL | 是否加 uid 过滤 |
| 云日志级联发现 | 结果算不算证据 |
| 返回原始日志 | 结果推理与归因 |

依据：`dev-agent-logs` 的 `src` 中 `catalog / resolve / evidence / observation / correlation` 零命中，仍被认定能力与官方对齐。**变量只有「约束」，不是形态。**

## 3. 工具面（14 个）

### 3.1 日志中心（7）

| 工具 | 官方对应 | 说明 |
| --- | --- | --- |
| `search_services` | `search` | 关键词搜服务，`authorized_found / unauthorized_found / not_found` |
| `list_services` | `list` | 按权限分页列表 |
| `get_fields` | `fields` | 获取 `index=true` 可查询字段 |
| `get_storage_type` | `storage-type` | `es/tls/cls/bls` 路由别名 |
| `count` | `count` | 统计总数，不返回内容 |
| `query` | `query` | Lucene 检索 |
| `dsl_search` | `dsl-search` | 透传 ES Query Body |

### 3.2 云日志（6）

**当前仅支持阿里云 SLS。** `vendor` 参数保留（默认 `aliyun`），传 `tencent` 时明确报错而非静默降级——腾讯云 CLS 留作后续扩展，接口形状已对齐，接入时无需改动签名。

| 工具 | 官方对应 | 关键参数 |
| --- | --- | --- |
| `cloud_accounts` | `cloud-accounts` | `vendor`（默认 `aliyun`） |
| `cloud_collections` | `cloud-collections` | `vendor`、`account`（必填） |
| `cloud_topics` | `cloud-topics` | `vendor`、`account`（必填）、`collection`（可选过滤） |
| `cloud_count` | `cloud-count` | 坐标 5 元组 + `time` |
| `cloud_search` | `cloud-search` | 坐标 5 元组 + `time` + `query` + `size` + `from` + `reverse` + `full` |
| `cloud_probe` | `cloud-probe` | `vendor`、`region`、`account`、`collection` |

**默认坐标（来自配置，MCP 不做运行时判断）**

5 元组里 4 个可固定，1 个动态：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `vendor` | `aliyun` | 当前仅支持阿里云 SLS |
| `region` | `cn-beijing` | 本服务配置默认值 |
| `account` | `1743276692096170` | 本服务配置默认值 |
| `collection` | `pysy-front-log` | 本服务配置默认值 |
| `topic` | — | 动态，由 `cloud_topics` 返回 |

落地方式：启动时从配置文件读这 4 个值，注入到云日志工具 schema 的 `default` 字段。调用方不传 → 用 default；传了 → 覆盖。MCP 内部**不做「if not 传 then 从配置取」的运行时判断**，只走 schema 默认值机制。

日常调用退化成「1 元组 + 查询条件」：调用方只需传 `topic` + `time` + `query`，其余 4 个坐标由配置兜底。

**`cloud_accounts` / `cloud_collections` 保留**：日常用不到（值在配置里），但调用方想跨账号 / 跨 collection 查时仍可用，工具面保持完整。

### 3.3 分流原则与 MCP 的关系

官方 skill 的分流原则是「默认走日志中心，明确提云厂商才走云日志」。这是**调用方应掌握的知识**，不约束 MCP 运行时。

MCP 侧的对策只有两条，都已落实：

1. 两类工具按名称分组（`search_services` / `query` vs `cloud_search`），不合并成同名工具
2. 每个工具的 `description` 写清适用边界，让模型按官方规则自行选择

**MCP 不做自动路由**：不在 `query` 内部偷偷切到云日志，也不在 `cloud_search` 内部回退到日志中心。路由是业务语义，归调用方。

### 3.4 两类日志的形态差异（必须理解，否则设计会错）

这是官方 skill 里最容易被忽略、但决定 API 形状的部分：

| 维度 | 日志中心 | 云日志 |
| --- | --- | --- |
| 定位方式 | **关键词搜服务** → `service_id` | **级联发现**：account → collection → topic |
| 发现能力 | 能按 name/topic/username/uid 模糊搜 | **只能列物理坐标**，无法按业务名反查 |
| 查询语法 | Lucene（ES 风格） | 阿里云 SLS 类 SQL；腾讯云 CLS Lucene 风格 |
| 时间字段 | `@timestamp`（毫秒，DSL）/ 秒级参数 | `__time__`（秒）/ `__TIMESTAMP__`（毫秒） |
| 分页语义 | `from` = **页码**（从 1 起） | `from` = **偏移量**（从 0 起） |
| 统计接口 | `count` 支持 `query` 过滤 | `cloud-count` **不支持 query**，只有 topic 总量 |
| DSL 能力 | 支持完整 ES Query Body | **不支持** |
| 返回结构 | `data.data[]` + `total` | `data.logs[]` + `data.total` + `progress` |

**两个关键陷阱**：

**① 分页语义不同**

```text
日志中心：from=1 → 第 1-40 条；from=2 → 第 41-80 条
云日志：  from=0 → 第 1-100 条；from=100 → 第 101-200 条
```

同一个参数名，含义相反。MCP 的工具 schema 必须用不同命名区分：`query(page)` vs `cloud_search(from)`。

**② `cloud_count` 不支持查询过滤**

官方 `cloud-count` API 只接收坐标和时间，**没有 query 参数**，只能返回 topic 总量。带条件的"统计"无法用它。

MCP 侧的处理：`cloud_count` 保持官方原样（不带 query），在 description 里明确写出这个限制，并提示「需要带条件统计时请用 `cloud_search` 的 `total`」。**不做自动降级**——是否改用 `cloud_search.total` 属于调用方决策。

**③ 业务名反查缺口**

云日志元数据只有物理坐标（account / collection / topic），**没有「业务名 → appid」的反查能力**——appid 是日志内容里的字段，而非 SLS 元数据（对应上表"发现能力"行）。`search_both_logs` 的云日志侧因此靠**全量扫 topic + 全文检索**去撞（见 3.5）。

**不内置日志地图**：业务别名词典属于调用方资产，放进公共 MCP 会导致维护权责不清。

### 3.5 聚合查询：`search_both_logs`

一次调用同时返回日志中心与云日志结果。云日志采用**全量 topic 遍历**（当前 topic 数量为个位数，开销可接受）。

#### 3.5.0 两侧平级、并行、互不依赖

| 原则 | 说明 |
| --- | --- |
| **平级** | 不区分主次。两侧都是同等的数据源，返回结构中不存在 `primary` / `supplementary` |
| **并行** | 两侧同时发起，总耗时取决于最慢一侧，而非两侧相加 |
| **互不依赖** | 云日志查询不使用日志中心的结果（不用 traceId 等做二次查询），同一个 `query` 参数各自表达 |
| **都必查** | 调用本工具即表示两侧都要查；任一侧失败不阻止另一侧继续 |
| **结果齐备** | 查询到的结果全部返回给调用方，由调用方自行决定如何使用 |

#### 3.5.1 两侧的发现路径不对称

```text
日志中心：keyword → search_services → service_id → 直接查
云日志：  keyword → （无业务名反查） → 全量 topic 遍历 → 逐个 query
```

云日志无业务名反查的原因见 3.4 ③，本节不再复述；结论是**只能全量扫 topic，用 query 去撞**。

#### 3.5.2 发现链路只需两层

关键简化：`cloud_topics` 不传 `collection_id` 时返回**该账号下全部 topic**，且每条自带 `collection_id` / `region`：

```jsonc
{
  "topic_id": "app-prod-log",
  "topic_name": "app-prod-log",
  "collection_id": "my-log-project",   // ← 自带，无需先列 collections
  "region": "cn-hangzhou",
  "vendor": "aliyun"
}
```

所以链路是：

```text
cloud_accounts(vendor)              # 1 次，10s 超时
  └→ 对每个 account：
       cloud_topics(account)        # 1 次，10s 超时
         └→ 对每个 topic：
              cloud_search(...)     # N 次，30s 超时，并发
```

**不需要**先遍历 `cloud_collections`。

#### 3.5.3 工具签名

```text
search_both_logs(
  keyword?: string,           # 日志中心搜服务用（发现 service_id）
  serviceId?: number,         # 已知 service_id 时直接查，跳过 search_services
  time: string,                # 两侧共用时间窗
  query?: string,             # 日志中心 Lucene
  page?: number,              # 日志中心页码（1 起）
  per_service_size?: number,  # 日志中心每个命中 service 返回条数，默认 20
  cloud?: {                   # 全部可选；缺省即全量
    vendor?: "aliyun",               # 当前仅支持阿里云 SLS
    account?: string,                # 缺省=所有账号
    collection?: string,             # 缺省=所有集合
    topic?: string,                  # 缺省=所有 topic
    query?: string,                  # SLS 类 SQL / CLS Lucene，默认 "*"
    per_topic_size?: number,         # 每个 topic 返回条数，默认 100
    from?: number,                   # 偏移量（0 起）
    reverse?: boolean
  },
  max_services?: number,      # 日志中心最多查多少个命中 service，默认 10
  max_topics?: number         # 云日志最多扫多少个 topic，默认 20
)
```

设计意图：

- **`cloud` 整体可选，其内部字段也全部可选**。不传 `cloud` 则只查日志中心；传空对象 `{}` 则全量扫所有 topic。
- **日志中心侧的发现流程**：`serviceId` 优先——传入则直接 `query`；未传则用 `keyword` 调 `search_services` 发现 `service_id` 再查；两者皆无则日志中心侧报错（云日志侧不受影响，仍按 `cloud` 配置执行）。`keyword` 与 `serviceId` 同时传时以 `serviceId` 为准，`keyword` 被忽略。
- **多 service 命中策略**：`keyword` 命中多个 service 时**全部都查**，结果按 service 分组（见 3.5.4）。受 `max_services` 兜底，超过上限的服务记入 `truncated.services_skipped`。
- **`per_service_size` / `per_topic_size` 与单点工具 `size` 区分命名**：聚合工具里每个 service/topic 各取 N 条，单点工具里是单个的每页条数，语义不同故不共用 `size`。

#### 3.5.4 返回结构

```jsonc
{
  "logcenter": {
    "scanned_services": 3,
    "matched_services": 2,        // total > 0 的 service 数
    "results": [                   // 按 service 分组，只含有命中的
      {
        "source": "logcenter",
        "service_id": 6111,
        "service_name": "...",
        "total": 1234,
        "logs": [...],
        "elapsed_ms": 120
      }
    ],
    "elapsed_ms": 800
  },
  "cloud": {
    "scanned_topics": 8,
    "matched_topics": 2,        // total > 0 的 topic 数
    "results": [                // 按 topic 分组，只含有命中的
      {
        "source": "cloud",
        "vendor": "aliyun",
        "account": "<account>",
        "collection": "<collection>",
        "topic": "<topic-a>",
        "region": "<region>",
        "total": 88,
        "logs": [...],
        "elapsed_ms": 156
      }
    ],
    "elapsed_ms": 2100
  },
  "partial_failures": [          // 任一 service/topic/一侧失败时出现
    {
      "side": "cloud",
      "vendor": "aliyun",
      "topic": "<topic-b>",
      "error": { "code": "upstream", "message": "HTTP 504" }
    }
  ],
  "truncated": {
    "services_skipped": 0,        // 超过 max_services 时 > 0
    "topics_skipped": 0          // 超过 max_topics 时 > 0
  }
}
```

要点：

| 设计 | 理由 |
| --- | --- |
| `logcenter.results` 按 service 分组 | 多 service 命中时各自日志结构不同，混在一个数组里无法解读 |
| `cloud.results` 按 topic 分组 | 同上 |
| 只返回 `total > 0` 的 service/topic | 避免空数组占满 context |
| `scanned_services` / `matched_services` / `scanned_topics` / `matched_topics` 都返回 | 让调用方判断「全空还是只扫了一部分」 |
| `partial_failures` 记录单个 service/topic 失败 | 一个失败不影响其余 |
| `truncated.services_skipped` / `topics_skipped` | 超过上限时显式告知，不静默截断 |

#### 3.5.5 五条设计约束

**① 两侧并行，cloud 内部也并行**

实现：`asyncio.gather(run_logcenter(...), run_cloud_all_topics(...), return_exceptions=True)`，云日志分支内部再 gather，信号量限流 8。耗时对比（8 个 topic）：

| 方式 | 耗时 |
| --- | --- |
| 串行（先日志中心再云日志） | 约 1s + 3s = **4s** |
| 并行（本方案） | max(1s, 3s) = **3s** |

topic 数量越多，并行收益越大。原则论述见 3.5.0。

**② 单侧、单 topic 失败均不影响整体**

`return_exceptions=True` + 每个 topic 独立 try。失败记入 `partial_failures`，其余结果照常返回。日志排查最忌讳「一个 topic 超时导致全盘无结果」。

**③ 空 service / 空 topic 不返回**

`total == 0` 的 service / topic 不进入 `results`，只在 `scanned_services` / `scanned_topics` 计数。全空时 `results: []`，比一堆空数组清爽得多。

**④ 分组，不归一化**

两侧时间字段不同（`@timestamp` vs `__time__`/`__TIMESTAMP__`），列表路径不同（`data.data[]` vs `data.logs[]`）。强行归一化必然丢字段，而丢字段正是「查到了却用不了」的根因。

**⑤ `max_services` / `max_topics` 兜底**

`max_services` 默认 10、`max_topics` 默认 20（当前个位数够用）。若未来 service/topic 增长到几十上百，全量扫会变慢，此时由调用方显式调大或改用精确坐标。超过上限时 `truncated.services_skipped` / `truncated.topics_skipped` 告知跳过数量。

### 3.6 约定

- `search_services` / `get_fields` / `get_storage_type` 是「不要日志地图」能成立的基础，必须实现。
- 不提供 `index_status`：查询前不体检，只管查，查不到由上游报错、调用方判断。对齐 `dev-agent-logs`（不调 `/skill/es-index/list`，`code !== 0` 直接抛错）。理由：① 索引物理状态是平台/运维职责，不是 MCP 查询能力；② 平台侧无法保证所有服务都建了索引，体检反而会诱导模型「看到部分索引关闭就放弃查询」，但热数据仍可查；③ 云日志侧（SLS）本就无此概念，两侧一致不体检。
- 工具面为官方 skill 的 13 个 + 1 个显式聚合 `search_both_logs`。
- 单侧工具不做自动路由；跨侧需求走 `search_both_logs`。

### 3.7 两类日志的解耦边界

两类日志**独立实现、独立维护**，共享面被压到最小。

#### 3.7.1 完全独立的部分

| 维度 | 日志中心 | 云日志 |
| --- | --- | --- |
| 客户端模块 | `clients/logcenter.py` | `clients/cloudlog.py` |
| 工具模块 | `tools/logcenter.py` | `tools/cloudlog.py` |
| 方法 / 工具数 | 7 | 6 |
| 网关前缀 | `/skill/service/*`<br>`/skill/search/*`<br>`/skill/dsl/*` | `/skill/cloud/*` |
| 查询语法 | Lucene / ES Query DSL | 阿里云 SLS 类 SQL |
| 返回列表路径 | `data.data[]` | `data.logs[]` |
| 分页语义 | 见 3.4（页码 vs 偏移量） | 见 3.4 |
| 统计过滤 | 支持 `query` | 不支持 |
| 调试路径 | `/mcp/logcenter` | `/mcp/cloud` |

#### 3.7.2 有意共用的部分

只有四个基础设施模块，重复实现才是缺陷：

| 共用项 | 理由 |
| --- | --- |
| `clients/sign.py` | 同一个网关注入，`md5(appid&ts+secret)` 完全相同 |
| `clients/time_range.py` | 时间语义通用（`1h` / `昨天` / 绝对区间） |
| `clients/redact.py` | 脱敏规则两侧一致（token/cookie/手机号/身份证），见 4 节 |
| `config.py` 的 `appid` / `appsecret` | 一对凭据可访问两类接口 |

#### 3.7.3 隔离的强制约束

三条硬规则，可用 lint 自动守住：

1. `tools/logcenter.py` 与 `tools/cloudlog.py` **不互相 import**
2. `clients/cloudlog.py` 与 `clients/logcenter.py` **不互相 import**
3. **唯一**允许同时 import 两者的是 `tools/aggregate.py`

违反任一即视为设计退化。

#### 3.7.4 唯一交叉点：`aggregate.py`

`search_both_logs` 的边界定义：

| 约束 | 说明 |
| --- | --- |
| 只调用客户端方法 | 不触碰工具层，不复制两侧工具逻辑 |
| 并行发起 | `asyncio.gather(return_exceptions=True)` |
| 单侧失败不影响另一侧 | 不重试、不降级、不回退 |
| 不做归一化 | 不合并结构、不统一字段名、不重排序 |
| 不进子集 | 只存在于 `/mcp`，不出现在 `/mcp/logcenter` 或 `/mcp/cloud` |

即：两类日志的耦合**只发生在聚合层，且是弱耦合**（并行调用 + 独立失败）。

#### 3.7.5 结果来源标识（`source`）

所有返回都带 `source` 字段，便于调用方与调试时区分来源：

```jsonc
// 单点工具
{ "source": "logcenter", "service_id": 6111, "total": 1234, "logs": [...] }
{ "source": "cloud",     "topic": "<topic>", "total": 88, "logs": [...] }

// 聚合工具：两侧各自带 source，每个 topic 结果也带
{
  "logcenter": { "source": "logcenter", "total": 1234, "logs": [...] },
  "cloud": {
    "source": "cloud",
    "results": [
      { "source": "cloud", "topic": "<topic>", "total": 88, "logs": [...] }
    ]
  }
}
```

同一标识也写入结构化日志，用于在交织的请求流中定位来源：

```python
LOGGER.info("upstream request", extra={
    "side": "cloud",                 # 'logcenter' | 'cloud'
    "topic": "<topic>",
    "path": "/skill/cloud/aliyun/search",
})
```

调试时 `grep '"side": "cloud"'` 即可捞出全部云日志请求。`side` 贯穿每次调用，比对 path 分离更有效。

### 3.8 工具契约（纯能力定义）

参考 `dev-agent-logs` 风格：每个工具只给「description（含关键约束）+ 参数表」，**不写返回结构**（由实现决定）、**不写错误场景**。`search_both_logs` 的签名见 3.5.3，此处不重复。

**通用参数 `env`**（仅日志中心 7 个工具有）：`{ production | test }`，缺省 `production`，切换网关与凭据。云日志无此参数（凭据按 `vendor`+`account` 区分，不按环境）；如需切换云日志测试环境，由 `account`/`collection`/`region` 入参指向不同账号下的测试 collection，不通过 `env` 控制。

**通用参数 `time`**：字符串，支持 `15m` / `1h` / `昨天` / `今天9:00到10:00` / 绝对区间。日志中心用秒级，云日志按 SLS 规范转 `__time__`（秒）或 `__TIMESTAMP__`（毫秒）。

#### 3.8.1 日志中心（7）

##### `search_services`

> 搜索日志中心服务，返回 `authorized_found` / `unauthorized_found` / `not_found` 三级结果（含权限自检）。serviceId 通过本工具动态发现，无需业务线预配置。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `keyword` | string | ✅ | — | 服务名 / topic / username / uid 模糊匹配 |
| `env` | string | — | `production` | 见通用参数 |

##### `list_services`

> 分页列出日志中心服务，按权限类型筛选。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `permission` | string | — | `authorized` | 枚举 `authorized` / `unauthorized` |
| `page` | number | — | `1` | 页码，从 1 起 |
| `size` | number | — | `20` | 每页条数，上限 100（对齐日志中心 API） |
| `keyword` | string | — | — | 可选过滤 |
| `env` | string | — | `production` | 见通用参数 |

##### `get_fields`

> 获取服务可查询索引字段（`index=true`），供构造 Lucene 或 DSL。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `serviceId` | number | ✅ | — | 由 `search_services` / `list_services` 返回 |
| `env` | string | — | `production` | 见通用参数 |

##### `get_storage_type`

> 获取服务存储类型及稳定别名（`es` / `tls` / `cls` / `bls`），决定查询语法路由。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `serviceId` | number | ✅ | — | — |
| `env` | string | — | `production` | 见通用参数 |

##### `count`

> 统计日志总数（不返回内容）。支持 `query` 过滤。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `serviceId` | number | ✅ | — | — |
| `time` | string | — | `15m` | 见通用参数 |
| `query` | string | — | `*` | Lucene |
| `env` | string | — | `production` | 见通用参数 |

##### `query`

> 检索日志内容（Lucene 语法）。**`page` 从 1 起（页码），每页 40 条**；时间用秒。`full: false` 返回精简字段，`full: true` 返回全字段；两者均过脱敏（见 4 节）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `serviceId` | number | ✅ | — | — |
| `time` | string | — | `15m` | 见通用参数 |
| `query` | string | — | `*` | Lucene |
| `page` | number | — | `1` | **页码**（非偏移） |
| `full` | boolean | — | `false` | 是否返回全字段（仍过脱敏，见 4 节） |
| `env` | string | — | `production` | 见通用参数 |

##### `dsl_search`

> 透传 ES Query Body。`@timestamp` 用毫秒；**禁 `script` / `script_fields`**；`from + size <= 10000`。返回的 `_source` 过脱敏（见 4 节，无 `full` 参数，始终全字段）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `serviceId` | number | ✅ | — | — |
| `dsl` | object | ✅ | — | ES Query Body |
| `size` | number | — | — | 与 `from` 之和 ≤ 10000；本身 ∈ [0,200]（见 4.1） |
| `from` | number | — | `0` | 偏移量（DSL 语义） |
| `env` | string | — | `production` | 见通用参数 |

#### 3.8.2 云日志（6）

**坐标 5 元组**：`vendor` + `account` + `collection` + `topic` + `region`。前 4 个有配置默认值（见 3.2 默认坐标表），`topic` 动态。下表「必填」按「是否必须显式传」标注——有默认值的标 `—`。

##### `cloud_accounts`

> 列出某 vendor 下的云日志账号。日常用不到（`account` 已在配置里），保留供跨账号场景。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `vendor` | string | — | `aliyun` | 传 `tencent` 报错 |

##### `cloud_collections`

> 列出某账号下的日志集（SLS project）。日常用不到（`collection` 已在配置里），保留供跨 collection 场景。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `vendor` | string | — | `aliyun` | — |
| `account` | string | ✅ | — | 覆盖配置默认时必传 |

##### `cloud_topics`

> 列出某账号下的全部 topic，每条自带 `collection` / `region`，**无需先调 `cloud_collections`**。不传 `collection` 时返回该账号全部 topic。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `vendor` | string | — | `aliyun` | — |
| `account` | string | ✅ | — | 覆盖配置默认时必传 |
| `collection` | string | — | — | 可选过滤 |

##### `cloud_count`

> 统计某 topic 日志总量。**不支持 `query` 过滤**（以官方 API 端点 `GET /api/skill/cloud/{vendor}/count` 为准，其参数只含坐标与时间；SKILL.md CLI 用法里列出的 `--query` 实际不生效）；需要带条件统计时请用 `cloud_search` 的 `total`。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `vendor` | string | — | `aliyun` | — |
| `account` | string | — | 配置默认 | — |
| `collection` | string | — | 配置默认 | — |
| `topic` | string | ✅ | — | — |
| `region` | string | — | 配置默认 | 跨 region 时由调用方显式传 |
| `time` | string | — | `15m` | 见通用参数 |

##### `cloud_search`

> 检索云日志内容（阿里云 SLS 类 SQL）。**`from` 从 0 起（偏移量，非页码）**；时间用秒（`__time__`）。`full` 语义同日志中心 `query`：`false` 精简、`true` 全字段，两者均过脱敏（见 4 节）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `vendor` | string | — | `aliyun` | — |
| `account` | string | — | 配置默认 | — |
| `collection` | string | — | 配置默认 | — |
| `topic` | string | ✅ | — | — |
| `region` | string | — | 配置默认 | 跨 region 时由调用方显式传 |
| `time` | string | — | `15m` | 见通用参数 |
| `query` | string | — | `*` | SLS 类 SQL |
| `size` | number | — | `100` | 每页条数，最大 1000 |
| `from` | number | — | `0` | **偏移量**（非页码） |
| `reverse` | boolean | — | `false` | 是否倒序 |
| `full` | boolean | — | `false` | 是否返回完整日志条目 |

##### `cloud_probe`

> 探测某 collection 在某 region 的可访问性与延迟。`region` 必填（无配置默认）。返回结构：

```jsonc
{
  "source": "cloud",
  "accessible": true,
  "vendor": "aliyun",
  "region": "<region>",
  "account": "<account>",
  "collection": "<collection>",
  "latency_ms": 120,
  "topics": ["<topic-a>", "<topic-b>"]   // 可访问的 topic 列表；不可达时为 []
}
```

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `vendor` | string | — | `aliyun` | — |
| `region` | string | ✅ | — | — |
| `account` | string | ✅ | — | 覆盖配置默认时必传 |
| `collection` | string | ✅ | — | — |

> `count` / `cloud_count` 等统计类工具的返回也带 `source`（如 `{source:"logcenter", service_id, total, start, end}` / `{source:"cloud", topic, total, ...}`），无 `logs` 字段。

## 4. 返回形态

| 项 | 规则 |
| --- | --- |
| 默认字段 | 精简（时间、级别、消息、trace、模块、服务名）；日志中心与云日志**各自维护白名单**（云日志字段如 `__time__`/`__source__`/`level`/`message` 与日志中心不同，不能共用），具体白名单待首轮联调后定 |
| 完整结果 | `full: true` 返回全字段（仍过脱敏，非裸日志） |
| 脱敏 | **始终执行**（含 `full: true`，两侧一致）。key 名匹配 `authorization\|cookie\|token\|access[-_]?key\|secret\|password\|passwd\|sign\|session\|jwt`（不区分大小写）→ `<redacted>`；字符串值脱敏手机号 → `<phone>`、身份证号 → `<id-card>`、URL 内 `token=xxx` 等参数 → `<redacted>`；`NaN/±Infinity` → `null`；`undefined` 字段丢弃 |
| 分页 | `query` 为页码（从 1 起，每页 40）；`cloud_search` 为 `from` 偏移 |
| 截断 | **不做**。MCP 不裁剪字段长度、不压缩条数上限（脱敏属字段值替换，非裁剪） |
| 来源标识 | 所有结果带 `source`：`"logcenter"` 或 `"cloud"`（详见 3.7.5） |

### 4.1 DSL 约束（沿用官方，MCP 侧强制校验）

`dsl_search` 在调用网关前做输入合法性校验，保护上游 ES 集群不被打挂或注入脚本。校验属物理层保护，不是业务语义判断。

| 校验项 | 规则 | 实现方式 |
| --- | --- | --- |
| 类型 | DSL 必须是 JSON 对象 | `typeof === 'object' && !Array.isArray` |
| 禁 key | `script` / `script_fields`（任意层级） | 递归遍历对象/数组的所有 key 和 value，命中即拒（对齐 `dev-agent-logs` `containsForbiddenKeys`） |
| `size` | ∈ [0, 200] | 数值比较 |
| `from + size` | ≤ 10000 | 超出抛错，提示改用 `search_after` |
| `from` 与 `search_after` | 互斥 | key 存在性判断 |
| `@timestamp` | 用毫秒，`format: "epoch_millis"` | description 提示，不强制校验 |

**校验失败一律抛错**，不静默修正——修正属于业务决策，归调用方。

### 4.2 时间参数

秒级时间戳；`time` 支持相对（`15m`/`1h`/`3d`/`1w`）、自然语言（`今天`/`昨天`/`本周`/`过去N天`）、绝对（`YYYY-MM-DD`、`今天9:00到10:00`、`YYYY-MM-DD HH:MM:SS~...`）。

## 5. 认证：OAuth 2.1 client_credentials

### 5.1 两层认证

| 层 | 关系 | 凭据 | 有效期 |
| --- | --- | --- | --- |
| 调用方 → MCP | 本次设计新增 | OAuth Access Token | 1 小时，自动续 |
| MCP → 日志中心 | 沿用现有 | `appid` / `appsecret` 签名 | 长期，不变 |

两层独立：Access Token 证明「谁在调用」，`appid` 证明「服务有权查日志」。

### 5.2 为什么用 client_credentials

手写 Token + 90 天手工轮换不可接受：到期前必须有人记得换，忘了就全链路中断。`client_credentials` 把这个问题从「运维日历」变成「程序行为」：

```text
调用方配置（长期不变）
  client_id     = "odyssey"
  client_secret = "<32 字节随机>"
        │
        │  POST /oauth/token  (grant_type=client_credentials)
        ▼
服务端签发短期令牌
  { access_token, token_type: "Bearer", expires_in: 3600 }
        │
        ▼
调用 MCP：Authorization: Bearer <access_token>
```

关键点：**`client_secret` 永不轮换，`access_token` 自动刷新。** 即使 `access_token` 泄露，有效期只有 1 小时；要立刻止损，吊销 `client_id` 即可。

### 5.3 端点

只实现 `client_credentials` 一个 grant type（服务对服务，不需要浏览器跳转的授权码流程）：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/oauth/token` | POST | 用 `client_id` + `client_secret` 换取 `access_token` |
| `/oauth/revoke` | POST | 主动吊销令牌（可选） |

请求：

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=odyssey
&client_secret=<secret>
&scope=logs:read
```

响应：

```json
{
  "access_token": "<32 字节随机>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "logs:read"
}
```

`/oauth/revoke` 用同一对 `client_id` + `client_secret` 自证（与 `/oauth/token` 一致，不依赖 access_token）：

```http
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=<access_token>&client_id=odyssey&client_secret=<secret>
```

成功返回 `204 No Content`，无 body。`token` 字段也可传 `client_id`（吊销整组令牌），按 RFC 7009 容错：未知 token 也返回 204。

### 5.3.1 工具调用错误返回结构

所有 MCP 工具调用失败时统一返回 `isError: true` + 标准 `content` 数组，错误内容集中在 `error` 对象：

```jsonc
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "{\"error\":{\"code\":\"upstream\",\"message\":\"HTTP 504 Gateway Timeout\",\"upstream\":{\"side\":\"cloud\",\"vendor\":\"aliyun\",\"topic\":\"<topic>\",\"status\":504}}}"
    }
  ]
}
```

| `error.code` | 触发场景 | 是否含 `upstream` |
| --- | --- | --- |
| `auth` | access_token 无效/过期/被吊销 | 否 |
| `permission` | scope 不足或日志中心服务未授权 | 否 |
| `bad_request` | 参数缺失/格式错误/size 越界 | 否 |
| `upstream` | 上游日志中心/云日志返回非 2xx | 是（`side`/`vendor`/`topic` 或 `service_id`/`status`） |
| `timeout` | 单次上游调用超过 `LOG_MCP_TIMEOUT_MS` | 是（同上） |
| `internal` | 未捕获异常 | 否 |

`search_both_logs` 的部分失败不进 `isError`，仍走 3.5.4 的 `partial_failures` 字段；只有两侧全部失败才返回 `isError: true`。

### 5.3.2 token scope 强制

`scope` 在 `oauth_clients.scopes` 注册时指定，签发时回填到 `oauth_tokens.scope`。校验中间件按工具维度强制：

| scope | 允许的工具 |
| --- | --- |
| `logs:read` | 全部 14 个工具（默认） |
| `logs:probe` | 仅 `cloud_probe` / `list_services` / `get_fields` |

调用方无对应 scope 时返回 `error.code = permission`，不暴露上游细节。

### 5.4 凭据存储（两张表）

凭据落在单文件 SQLite（`auth.db`），含两张表，职责分离：

| 表 | 存什么 | 对应凭据 |
| --- | --- | --- |
| `oauth_clients` | 注册的调用方（client_id + secret_hash + scopes + revoked） | **颁发的 client 凭据**（长期，换 token 用） |
| `oauth_tokens` | 签发的访问令牌（token_hash + client_id + scope + 过期时间） | **生成的 access token**（短期，1 小时） |

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL,        -- sha256(client_secret)
  description    TEXT NOT NULL DEFAULT '',
  scopes         TEXT NOT NULL DEFAULT 'logs:read',
  created_at     TEXT NOT NULL,
  revoked        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash     TEXT PRIMARY KEY,     -- sha256(access_token)
  client_id      TEXT NOT NULL,
  scope          TEXT NOT NULL,
  issued_at      TEXT NOT NULL,
  expires_at     TEXT NOT NULL           -- issued_at + 3600s
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
```

设计要点：

| 要点 | 理由 |
| --- | --- |
| 只存 `sha256(secret)` 与 `sha256(token)` | 库被拖走也拿不到可用凭据 |
| `client_secret` 不过期 | 换 token 的长期凭据，靠 `revoked` 吊销 |
| `access_token` 1 小时 | 泄露窗口小 |
| 过期 token 定时清理 | 避免表无限增长 |
| `client_id` 记审计 | 日志可追溯调用来源 |

### 5.5 续期行为

客户端责任（写入接入文档）：

```text
1. 启动或首次调用前：POST /oauth/token 取 access_token
2. 缓存 access_token，记录 expires_at
3. 距过期 < 5 分钟时提前续期（不要等 401）
4. 收到 401 时立即重新换 token 并重试一次
```

服务端职责：

| 场景 | 行为 |
| --- | --- |
| token 有效 | 放行，`scope["state"]["client_id"]` 注入 |
| token 过期 | 401 + `WWW-Authenticate: Bearer error="invalid_token"` |
| token 不存在 | 同样 401，不区分「不存在」与「过期」 |
| `client_secret` 错误 | `/oauth/token` 返回 401 + `invalid_client` |

### 5.6 安全要求

- `client_secret` 与 `access_token` 均用 `hmac.compare_digest` 常量时间比较
- `Authorization` 头不得进入日志，审计只记 `client_id`
- 401 响应不区分「token 不存在」与「已过期」，避免探测
- `client_secret` / `access_token` 生成使用 `secrets.token_urlsafe(32)`
- 令牌校验在 MCP 协议层之前完成

### 5.7 Token 与客户端的 CLI 管理

```bash
# 注册调用方（输出 client_secret，仅此一次可见）
uv run python manage.py client register --client-id odyssey --description "troubleshoot-odyssey"

# 吊销（立即失效）
uv run python manage.py client revoke --client-id odyssey

# 列表（不显示 secret）
uv run python manage.py client list
```

**只有 `client register` 会返回 `client_secret`，之后无法再查。** 丢失只能吊销重建。

### 5.8 Starlette 鉴权能力核实

Starlette 1.8.0 内置 `AuthenticationMiddleware` + `AuthenticationBackend`，但**不适用于 MCP 场景**：内置中间件认证失败时只把用户标记为 `UnauthenticatedUser` 而不拒绝请求，且 MCP 路由由 SDK 内部生成、没有注入身份校验的入口。

**结论**：必须使用**自定义 ASGI 包装器**。`dev-agent` 采用的正是这个方案（`BearerAuthDispatcher`），本服务沿用。

### 5.9 鉴权中间件实现

`/oauth/token` 不需要令牌（它就是发令牌的），`/mcp` 需要：

```python
class BearerAuthDispatcher:
    """校验 OAuth access_token，通过后注入 client_id。"""

    def __init__(self, *, app: ASGIApp, token_store: TokenStore) -> None:
        self.app = app
        self.token_store = token_store

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        header = Headers(scope=scope).get("authorization")
        client_id = self.token_store.verify_access_token(header)
        if client_id is None:
            response = JSONResponse(
                {"error": "invalid_token"},
                status_code=401,
                headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
            )
            await response(scope, receive, send)
            return
        scope["state"] = {**(scope.get("state") or {}), "client_id": client_id}
        await self.app(scope, receive, send)
```

装配：

```python
mcp_app   = server.streamable_http_app(stateless_http=True, streamable_http_path="/")
auth_app  = BearerAuthDispatcher(app=mcp_app, token_store=token_store)

app = Starlette(routes=[
    Route("/health",       health,                    methods=["GET"]),
    Route("/oauth/token",  oauth_token,               methods=["POST"]),
    Route("/oauth/revoke", oauth_revoke,              methods=["POST"]),
    Mount("/mcp",          app=auth_app),
])
```

| 端点 | 鉴权 |
| --- | --- |
| `/health` | 否（K8s 探针带不了 Token） |
| `/oauth/token` | 否（用 client_secret 自证） |
| `/oauth/revoke` | 否（用 client_secret 自证） |
| `/mcp` | **是**（Bearer access_token） |

### 5.10 参考实现

`dev-agent` 的常量时间比较写法，本服务沿用：

```17:22:knowledge/dev-agent/resources-mcp/src/resources_mcp/transport/auth.py
def authenticate_bearer(authorization: str | None, expected: str) -> bool:
    """校验服务端共享令牌，不承载用户或仓库授权信息。"""
    scheme, separator, token = (authorization or "").partition(" ")
    return (
        separator == " " and scheme.lower() == "bearer"
        and bool(token) and bool(expected)
        and hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8"))
    )
```

差异：`dev-agent` 是单 Token 共享；本方案是 OAuth client_credentials 签发短期令牌 + 哈希存储。

### 5.11 存储位置

凭据库落在**数据盘**，与 runtime 共用统一数据根，容器重建不丢（表结构见 5.4）：

```text
${HARMONY_AGENT_DATA_ROOT:-.data}/log-mcp/auth.db
```

- 本地默认：`troubleshoot-odyssey/.data/log-mcp/auth.db`
- 容器：`/data/troubleshoot-odyssey/log-mcp/auth.db`（随主数据卷持久化）

## 6. 配置加载

### 6.1 配置文件位置

凭据与配置放 `log-mcp/config/`，**不提交 git**：

```text
log-mcp/
  config/
    log-mcp.local.json     # 本地开发，不提交
    log-mcp.local.json.example  # 模板，提交
```

`.gitignore` 追加：

```gitignore
log-mcp/config/*.local.json
log-mcp/config/*.local.env
```

### 6.2 环境变量优先级

环境变量优先于配置文件（便于容器注入覆盖）：

```text
优先级：环境变量 > 配置文件 > 内置默认
```

| 环境变量 | 对应配置 | 说明 |
| --- | --- | --- |
| `LOG_MCP_HOST` | `host` | 默认 `127.0.0.1` |
| `LOG_MCP_PORT` | `port` | 默认 `8766` |
| `LOG_MCP_DATA_ROOT` | `dataRoot` | 默认 `${HARMONY_AGENT_DATA_ROOT:-.data}` |
| `LOG_MCP_ENV` | `env` | 默认 `production`，可选 `test` |
| `LOG_MCP_PROD_APPID` | `logcenter.production.appid` | 生产凭据 |
| `LOG_MCP_PROD_APPSECRET` | `logcenter.production.appsecret` | 生产凭据 |
| `LOG_MCP_TEST_APPID` | `logcenter.test.appid` | 测试凭据 |
| `LOG_MCP_TEST_APPSECRET` | `logcenter.test.appsecret` | 测试凭据 |
| `LOG_MCP_LOGCENTER_BASE_URL` | `logcenter.baseUrl` | 覆盖网关地址 |
| `LOG_MCP_TIMEOUT_MS` | `timeoutMs` | 默认 `30000`；**单次上游 HTTP 调用**的超时（每次日志中心/云日志 API 请求独立计时），不是整个工具调用的总耗时上限。`search_both_logs` 两侧并行各受此约束，不叠加 |
| `LOG_MCP_AUTH_DISABLED` | `auth.disabled` | 默认 `false`；仅本地回环地址生效（见 7.5.3） |

### 6.3 多环境切换

生产与测试凭据**同时加载**，由工具入参 `env` 选择，不在启动时二选一：

```jsonc
{
  "logcenter": {
    "production": { "appid": "...", "appsecret": "..." },
    "test": { "appid": "...", "appsecret": "..." }
  }
}
```

这样一次部署即可查两个环境，与 `dev-agent-logs` 的 `env` 参数语义一致。

### 6.4 云日志默认坐标

云日志 5 元组里 4 个固定坐标从配置注入（默认值见 3.2 默认坐标表）。启动时读取，注入到云日志 6 个工具的 schema `default`。`topic` 不设默认值（动态），仍由 `cloud_topics` 返回后由调用方传入。

**对应环境变量**（覆盖配置文件值）：

| 环境变量 | 对应配置 | 说明 |
| --- | --- | --- |
| `LOG_MCP_CLOUDLOG_VENDOR` | `cloudlog.vendor` | 默认 `aliyun`，传 `tencent` 报错 |
| `LOG_MCP_CLOUDLOG_REGION` | `cloudlog.defaults.region` | 默认 `cn-beijing` |
| `LOG_MCP_CLOUDLOG_ACCOUNT` | `cloudlog.defaults.account` | 云账号 ID |
| `LOG_MCP_CLOUDLOG_COLLECTION` | `cloudlog.defaults.collection` | 默认 `pysy-front-log` |

### 6.5 容器注入

Dockerfile 中通过 `ENV` 或平台配置注入，参考现有 `COPY config/.env ./.env` 模式：

```dockerfile
ENV LOG_MCP_PORT=8766
ENV LOG_MCP_ENV=production
# 凭据由平台在部署时注入，不写入镜像层
```

**凭据不写入镜像**：要么由平台 secret 注入环境变量，要么在容器启动时写入 `config/log-mcp.local.json`（`chmod 0600` 后由进程读取）。

## 7. 进程管理与服务编排（参考 dev-agent）

### 7.1 运行形态

常驻独立进程，Agent 只通过 HTTP 连接，从不 spawn。

```
Agent 进程 ──HTTP+Bearer──> log-mcp :8766
                               │
                               └─> 日志中心网关 / SLS / CLS
```

### 7.2 管理脚本四动作

对齐 `dev-agent/scripts/runtime.py` 的语义：

```bash
uv run python manage.py start     # 启动，等待就绪
uv run python manage.py stop      # 优雅停止
uv run python manage.py status    # 查看运行状态
uv run python manage.py check     # 健康检查 + MCP 协议验证
```

### 7.3 六项保护机制

以下全部对齐 `dev-agent` 的实现：

**① PID 防复用**：进程记录保存 `pid` + 进程签名（启动时间 + 命令行），停止前校验签名，避免 PID 被复用后误杀其他进程。

**② 端口占用保护**：启动前检查端口，若被非托管进程占用则拒绝启动，不静默失败。

**③ 健康检查**：`GET /health` 返回 `{"status":"ok"}` 才认为进程就绪。

**④ MCP 协议级验证**：`check` 动作不只查 `/health`，还要真做一次 MCP 握手并 `list_tools()`，确认工具清单正确。本服务对应：验证 `search_services` 等 14 个工具名齐全。

**⑤ 优雅停止**：SIGTERM 后等待至多 25 秒；超时则报错而非直接 kill，避免截断进行中的查询。

**⑥ 并发保护**：管理脚本用文件锁，避免同时执行两次 `start`。

> 上述六项的实现细节（PID 签名计算、端口探测、健康检查、协议握手、SIGTERM 等待、文件锁）均直接复用 `dev-agent/scripts/runtime.py` 的语义，本服务按 Python 翻译，源码引用见实现阶段。

### 7.4 目录布局

区分**可变运行态**（数据盘）与**代码/配置**（仓库）：

```text
log-mcp/
  pyproject.toml
  uv.lock
  manage.py                       # 进程管理 + Token CLI
  src/log_mcp/                    # 详见 8.5
  config/
    log-mcp.local.json.example    # 模板，提交
    log-mcp.local.json            # 实际配置，不提交
```

可变运行态按统一数据根派生，**不在仓库目录内**：

```text
${HARMONY_AGENT_DATA_ROOT:-.data}/log-mcp/
  run/
    log-mcp.json      # {pid, signature, profile}，权限 0600
    manage.lock       # 管理脚本互斥锁
  logs/
    log-mcp.log       # 进程 stdout/stderr，权限 0600
  auth.db             # OAuth 凭据库（见 5.4），权限 0600
```

本地默认落到 `troubleshoot-odyssey/.data/log-mcp/`（已被 `.gitignore` 的 `.data/` 覆盖）；容器内为 `/data/troubleshoot-odyssey/log-mcp/`，随主数据卷持久化。

### 7.5 端点

**对外只暴露一个 MCP 入口；调试路径仅用于分侧验证。**

| 端点 | 工具数 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `/mcp` | 14 | Bearer | **对外唯一入口** |
| `/mcp/logcenter` | 7 | Bearer | 调试：只测日志中心 |
| `/mcp/cloud` | 6 | Bearer | 调试：只测云日志 |
| `/health` | — | 无 | 存活探针 |
| `/oauth/token` | — | 无 | 换取 access_token |
| `/oauth/revoke` | — | 无 | 吊销令牌 |

#### 7.5.1 多 path 的实现方式

工具注册函数写一次，按组装配到不同 `MCPServer` 实例：

```python
TOOL_GROUPS = {
    "logcenter": register_logcenter_tools,   # 7 个
    "cloud":     register_cloudlog_tools,    # 6 个
    "aggregate": register_aggregate_tools,   # 1 个
}

def build_server(groups: list[str]) -> MCPServer:
    server = MCPServer(id=f"log-mcp-{'-'.join(groups)}", ...)
    for group in groups:
        TOOL_GROUPS[group](server)           # 同一份函数，注册到不同实例
    return server

servers = {
    "all":       build_server(["logcenter", "cloud", "aggregate"]),  # 14
    "logcenter": build_server(["logcenter"]),                        # 7
    "cloud":     build_server(["cloud"]),                            # 6
}
```

挂载：

```python
app = Starlette(routes=[
    Route("/health",       health,       methods=["GET"]),
    Route("/oauth/token",  oauth_token,  methods=["POST"]),
    Route("/oauth/revoke", oauth_revoke, methods=["POST"]),
    Mount("/mcp",           app=auth_wrap(servers["all"])),
    Mount("/mcp/logcenter", app=auth_wrap(servers["logcenter"])),
    Mount("/mcp/cloud",     app=auth_wrap(servers["cloud"])),
])
```

要点：

- 工具定义**只写一遍**，注册函数被多实例复用，无重复维护
- `aggregate` 只进 `all`：它依赖两侧，放进任一侧子集都不成立
- 调试时 `list_tools()` 只返回该侧工具，不受另一侧干扰

代价：多 2 个 `MCPServer` 实例 + lifespan 中多 2 个 `session_manager.run()`，量级可忽略（dev-agent 已运行 8 个实例）。

#### 7.5.2 鉴权策略

所有 MCP path **统一走 Bearer**，调试 path 不例外——它们暴露同样的查询能力，不鉴权等于绕过认证。

`/health`、`/oauth/token`、`/oauth/revoke` 不鉴权：探针无法携带令牌，OAuth 端点本身用于发放令牌。

#### 7.5.3 本地开发跳过鉴权

配置项 `LOG_MCP_AUTH_DISABLED`（默认 `false`），仅用于本地调试免换 token。

三道护栏防止误用：

| 护栏 | 行为 |
| --- | --- |
| 监听地址约束 | 仅当 `LOG_MCP_HOST` 为 `127.0.0.1` / `localhost` 时开关生效；绑定 `0.0.0.0` 时**强制忽略并报错** |
| 启动告警 | 关闭鉴权时打印 `WARN: 鉴权已关闭，仅限本地开发` |
| 状态可见 | `/health` 返回 `{"status":"ok","auth":"disabled"}`，便于确认当前状态 |

第 1 条是核心保障：即便在容器里误配，绑定非回环地址也会让开关失效。

### 7.6 容器内编排

**独立服务**，与 runtime 同级、彼此独立，互不为父子进程。runtime 如何接入本服务由 runtime 侧自行决定，本方案不约束。

```text
Pod
├─ supervisord（PID 1）
│   ├─ log-mcp    :8766
│   └─ runtime    :8000
```

| 项 | 要求 |
| --- | --- |
| 进程管理 | supervisord，两个 program 各自 `autorestart=true` |
| 日志 | 按进程分离到不同文件 |
| 探针 | 各自独立 livenessProbe |
| 停止 | supervisord 负责向两个 program 转发 SIGTERM |
| 数据卷 | 数据根挂持久卷（Token 表需要持久化） |
| 环境变量 | `LOG_MCP_*` 由 Dockerfile `ENV` 或平台注入 |

选择 supervisord 而非 entrypoint 脚本的理由：PID 1 信号转发、自动重启、日志分离是它的标准职责，无需自行实现。

## 8. 技术栈

### 8.1 总览

**Python 3.13 + MCP Python SDK + Starlette + uvicorn**，与 `dev-agent` 的 `resources-mcp` 保持同一技术路线。

| 层 | 选型 | 版本 | 理由 |
| --- | --- | --- | --- |
| 语言 | Python | `>=3.13,<3.14` | 与 dev-agent 一致；MCP Python SDK 能力最全 |
| MCP 框架 | `mcp` | `>=2.3,<3` | 官方 SDK，提供 `MCPServer` + Streamable HTTP |
| ASGI 应用 | `starlette` | 随 mcp 传递依赖 | 轻量，MCP SDK 的 `streamable_http_app()` 返回的就是 ASGI app |
| HTTP 服务 | `uvicorn` | `>=0.54,<0.55` | dev-agent 同版本 |
| HTTP 客户端 | `httpx` | `>=0.28.1,<1` | 异步，支持连接池与超时 |
| 数据校验 | `pydantic` | `>=2.13.5,<3` | 工具入参 schema |
| 配置 | `pydantic-settings` | `>=2.15.0,<3` | 环境变量分层加载（env > file > default） |
| Token 存储 | 标准库 `sqlite3` | 内置 | 单表足够，无额外依赖 |
| 包管理 | `uv` | — | dev-agent 同款，`uv sync` / `uv run` |
| 代码规范 | `ruff` | `>=0.17.0,<0.18` | dev-agent 同版本 |

### 8.2 明确不用 FastAPI

`dev-agent` 的 **Agent 服务（`agent/`）用 FastAPI**，但 **MCP 服务（`resources-mcp/`）不用**——它的依赖里没有 `fastapi`，直接基于 Starlette。

```toml
# knowledge/dev-agent/resources-mcp/pyproject.toml
dependencies = [
    "httpx>=0.28.1,<1",
    "mcp>=2.3,<3",
    "pydantic>=2.13.5,<3",
    "pydantic-settings>=2.15.0,<3",
    "uvicorn>=0.54,<0.55",
]
```

本服务**跟随 `resources-mcp` 而非 `agent`**：MCP 服务只需要「MCP 端点 + 一个 `/health`」，FastAPI 的路由、依赖注入、OpenAPI 文档都用不上，引入即多余。

### 8.3 MCP Server 装配方式

核心是 `MCPServer` + `streamable_http_app()`：

```python
from mcp.server.mcpserver import MCPServer
from starlette.applications import Starlette
from starlette.routing import Mount, Route
from starlette.responses import JSONResponse

server = MCPServer(name="log-mcp", instructions="...")

@server.tool(name="search_services", description="...", structured_output=True)
async def search_services(keyword: str, env: str = "production") -> dict:
    ...

mcp_app = server.streamable_http_app(
    stateless_http=True,
    streamable_http_path="/",
)

async def health(_request):
    return JSONResponse({"status": "ok"})

app = Starlette(
    lifespan=lifespan,
    routes=[
        Route("/health", health, methods=["GET"]),
        Mount("/mcp", app=mcp_app),
    ],
)
```

关键参数：

| 参数 | 值 | 理由 |
| --- | --- | --- |
| `stateless_http=True` | 无会话状态 | 允许多副本、无粘性会话；日志查询本身无状态 |
| `streamable_http_path="/"` | 挂到 `/mcp` 根 | 路径由外层 `Mount` 控制，与 dev-agent 一致 |
| `structured_output=True` | 返回结构化结果 | 模型与调用方都更易消费 |

### 8.4 lifespan 管理

对齐 `dev-agent` 的做法——用 `AsyncExitStack` 管理资源生命周期：

```python
@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    async with contextlib.AsyncExitStack() as stack:
        await stack.enter_async_context(server.session_manager.run())
        stack.push_async_callback(http_client.aclose)
        stack.push_async_callback(token_store.close)
        yield
```

要点：`server.session_manager.run()` **必须**在 lifespan 内进入，否则 Streamable HTTP 无法工作——这是 dev-agent 里的既有写法。

### 8.5 目录结构

```text
log-mcp/
  pyproject.toml
  uv.lock
  .python-version
  src/log_mcp/
    __init__.py
    config.py           # pydantic-settings：env > config file > default
    server.py           # MCPServer 装配 + Starlette + uvicorn 入口
    auth.py             # Bearer 校验 ASGI 包装器
    oauth.py            # /oauth/token + /oauth/revoke
    token_store.py      # sqlite3 单表读写
    clients/
      __init__.py
      sign.py           # md5(appid&ts + appsecret)
      logcenter.py      # 日志中心：7 个方法
      cloudlog.py       # 云日志：6 个方法
      time_range.py     # 时间解析
      redact.py         # 脱敏（token/cookie/手机号/身份证），两侧共用
    tools/
      __init__.py
      logcenter.py      # 7 个工具注册
      cloudlog.py       # 6 个工具注册
      aggregate.py      # search_both_logs：并行 + 单侧失败隔离
  manage.py             # start/stop/status/check + client register/revoke/list
  config/
    log-mcp.local.json.example
  tests/
```

`src/` 布局（而非平铺）的理由：可安装为包，`pyproject.toml` 里 `[project.scripts]` 注册 `log-mcp` 命令，与 `resources-mcp` 一致。

### 8.6 模块与依赖来源

**外部依赖**：

| 依赖 | 来源 | 用途 |
| --- | --- | --- |
| `mcp` | PyPI | `MCPServer`、`@server.tool` 装饰器、`streamable_http_app()`、`session_manager` |
| `starlette` | PyPI（随 mcp 传递） | `Starlette`、`Mount`、`Route`、`JSONResponse`、ASGI 中间件协议 |
| `uvicorn` | PyPI | `uvicorn.run(app, host, port, log_config=None, access_log=False)` |
| `httpx` | PyPI | `AsyncClient` 连接池 + `AsyncBaseTransport`（测试注入） |
| `pydantic-settings` | PyPI | `BaseSettings` 自动读环境变量，`model_config` 指定 `.json` 源 |
| `sqlite3` | 标准库 | Token 表；单文件，无需服务 |

**内部模块移植**：

| 模块 | 移植来源 | 改动 |
| --- | --- | --- |
| 签名 `sign.py` | `dev-agent-logs/src/appx/sign.mjs` | 直接翻译，逻辑不变 |
| 日志中心客户端 | `dev-agent-logs/src/appx/log.mjs` | 改写为 `httpx.AsyncClient` |
| 时间解析 | `dev-agent-logs/src/appx/log.mjs::parseTimeRange` | 直接翻译 |
| 脱敏 `redact.py` | `dev-agent-logs/src/appx/log.mjs::redact` | 直接翻译，两侧共用 |
| 云日志客户端 | `logcenterskill/scripts/logsearch.py::*_cloud_*` | 参考官方实现补齐 |
| 工具注册 | `dev-agent-logs/src/appx/tools.mjs` | `defineTool` → `@server.tool` |
| 鉴权 | `dev-agent/.../transport/auth.py` | 单 Token → OAuth client_credentials |
| 进程管理 | `dev-agent/scripts/runtime.py` | Python 版直接复用语义 |

### 8.7 开发命令

```bash
uv sync                                   # 安装依赖
uv run log-mcp                            # 前台启动
uv run python manage.py start             # 托管启动
uv run python manage.py check             # 健康 + 协议验证
uv run ruff check .                       # 规范检查
uv run pytest                             # 测试
```

## 9. 明确不做

| 不做 | 原因 |
| --- | --- |
| 日志地图 / 业务别名词典 | 业务语义归调用方；改用全量 topic 遍历覆盖（见 3.5） |
| uid / 手机号 / traceId 注入 | 同上 |
| evidence / observation 标记 | 裁决权归调用方 |
| 结果二次截断 | 掩盖信息，导致误判 |
| `index_status` | 查询前体检属平台/运维职责，非 MCP 能力；对齐 `dev-agent-logs` 不体检；平台无法保证索引全建，体检会诱导错误放弃 |
| 改动 `troubleshoot-odyssey` | 本版仅新建 `log-mcp` |
| Token → 日志中心凭据映射 | 分级权限留作后续演进 |

## 10. 验收标准

| 项 | 标准 |
| --- | --- |
| 工具面完整性 | 14 个工具均可调用，参数与官方 skill 语义一致 |
| 无业务耦合 | 入参不含 uid / 业务别名 / evidence 相关字段 |
| 结果完整性 | `full: true` 可获取全字段日志（仍过脱敏，非裸日志） |
| 脱敏生效 | 所有返回（含 `full: true`、DSL `_source`、云日志）的敏感值被替换：token/cookie/手机号/身份证；`full: false` 与 `full: true` 均脱敏 |
| 独立运行 | 进程可独立启动停止；停止不影响其他服务 |
| 管理完备 | 四动作可用，`check` 能验证 14 个工具名 |
| 鉴权生效 | 无 Token 返回 401；无效/过期 Token 返回 401；吊销 client 后立即失效 |
| 聚合可用 | `search_both_logs` 不传 `cloud` 时只查日志中心；传 `{}` 时全量扫所有 topic；`serviceId` 与 `keyword` 优先级正确（serviceId 胜出）；多 service 命中时全部查询，结果按 service 分组 |
| 聚合隔离 | 单侧或单 service / 单 topic 失败时其余结果仍返回，失败记入 `partial_failures`；两侧全部失败才返回 `isError: true` |
| 模块隔离 | `tools/logcenter.py` 与 `tools/cloudlog.py` 无相互 import；仅 `aggregate.py` 同时引用 |
| 来源可辨 | 所有工具返回含 `source`；`count` / `cloud_count` 等统计类返回也含 `source`；结构化日志含 `side` |
| 调试路径 | `/mcp/logcenter` 只返回 7 个工具；`/mcp/cloud` 只返回 6 个；均需 Bearer |
| 免鉴权护栏 | `LOG_MCP_AUTH_DISABLED=true` 且绑定 `0.0.0.0` 时开关失效并报错 |
| 空 service / 空 topic 过滤 | `total=0` 的 service / topic 不出现在 `results`，但计入 `scanned_services` / `scanned_topics` |
| 上限兜底 | service 数超 `max_services` 时 `truncated.services_skipped > 0`；topic 数超 `max_topics` 时 `truncated.topics_skipped > 0` |
| 错误结构 | 失败工具返回 `isError: true` + `error.code` ∈ {auth, permission, bad_request, upstream, timeout, internal}；`upstream`/`timeout` 含 `upstream` 字段 |
| scope 强制 | `logs:probe` scope 仅可调 `cloud_probe` / `list_services` / `get_fields`；调用其他工具返回 `permission` 错误 |
| 探测结构 | `cloud_probe` 返回 `{source, accessible, vendor, region, account, collection, latency_ms, topics[]}` |
| 凭据安全 | 存储中无明文 secret/token；日志中无 `Authorization` 头 |
| 凭据隔离 | `config/*.local.json` 不出现在 git 跟踪中 |
| 令牌续期 | 用 client_secret 可换取 access_token；过期前可重复换取 |
| 环境变量优先 | 同名配置可被 `LOG_MCP_*` 覆盖 |
| 双环境可用 | 同一进程可分别以 `env=production` / `env=test` 查询 |
| 错误可读 | 上游错误透传原始消息，不吞异常 |

## 11. 实施步骤

1. 新建 `troubleshoot-odyssey/log-mcp/`，`pyproject.toml` + `mcp` / `starlette` / `uvicorn` / `httpx` 依赖
2. 迁入签名与日志中心客户端（Python 翻译），补齐 `get_fields` 与 `dsl_search`
3. 实现配置加载（`env > file > default`）
4. 实现 14 个工具注册（13 个官方对齐 + `search_both_logs`）
5. 实现 `/mcp` 与 `/health` 端点
6. 实现 OAuth client_credentials（`/oauth/token`、令牌表、校验中间件、CLI）
7. 编写 `manage.py`（四动作 + 六项保护机制 + Token CLI）
8. 用 `dev-agent-logs` 的调用序列做对照验证
9. 编写 supervisord 配置与容器编排

## 12. 已定事项

仅列具体取值；规则性内容见正文对应章节。

| 事项 | 决定 | 详见 |
| --- | --- | --- |
| 目录位置 | `troubleshoot-odyssey/log-mcp/` | 1、11 |
| 监听端口 | `8766` | 6.2 |
| Token 存储 | 数据盘 SQLite，两张表 `oauth_clients` + `oauth_tokens`（见 5.4） | 5.4 |
| 凭据配置 | `log-mcp/config/log-mcp.local.json`，不提交 git | 6.1 |
| 部署形态 | 独立 HTTP MCP 服务（Starlette + uvicorn），非 stdio 子进程；runtime 接入由 runtime 侧负责 | 7.6 |
| 聚合分组 | `search_both_logs` 命中多个 service / 多个 topic 时全部查询，按 service / topic 分组返回 | 3.5.4 |
| 聚合分页 | `per_service_size` 默认 20、`per_topic_size` 默认 100；与单点工具 `size` 区分命名 | 3.5.3 |
| 聚合上限 | `max_services` 默认 10、`max_topics` 默认 20；超限走 `truncated.services_skipped` / `topics_skipped` | 3.5.5 |
| 错误结构 | `isError: true` + `error.{code,message,upstream?}`；`code` ∈ {auth, permission, bad_request, upstream, timeout, internal} | 5.3.1 |
| token scope | `logs:read`（全部 14 工具，默认）/ `logs:probe`（仅 `cloud_probe` / `list_services` / `get_fields`），按工具强制 | 5.3.2 |
| 超时作用范围 | `LOG_MCP_TIMEOUT_MS` 是单次上游 HTTP 调用超时，非整个工具调用总耗时；`search_both_logs` 两侧并行各受此约束 | 6.2 |
| 云日志 env | 云日志无 `env` 参数，仅生产；测试环境通过 `account`/`collection`/`region` 指向不同账号下的测试 collection | 3.4 |
| 云日志精简白名单 | 与日志中心各自维护，首轮联调后另定 | 4 |
| `cloud_probe` 返回 | `{source, accessible, vendor, region, account, collection, latency_ms, topics[]}` | 3.8.2 |
| `dsl_search.size` 范围 | `[0, 200]`，与 `from` 之和 ≤ 10000 | 4.1、3.8.1 |
| `list_services.size` 上限 | 100 | 3.3 |
| 统计类返回 | `count` / `cloud_count` 等返回也带 `source`，无 `logs` 字段 | 3.7.5、3.8.2 |
