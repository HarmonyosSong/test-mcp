---
name: query-platform-logs
description: 通过 log-mcp 的 14 个只读工具查询线上日志——日志中心（ES/Lucene，按服务发现）与阿里云 SLS 云日志（三端技术日志、前端技术日志、未来云产品日志）。需要事故时间窗内的线上日志佐证时使用；用户已贴出日志或问题纯靠源码/知识可答时不必使用。
metadata:
  version: "0.2.0"
  stage: investigate
  modes: [chat]
  required_tools: [cloud_search, query, search_both_logs]
---

# 查询平台日志（log-mcp）

日志来自两个独立引擎，工具各半、可混用；任一侧失败不影响另一侧（会进 `partial_failures`）。
所有返回均过服务端脱敏（敏感字段值替换为 `<redacted>`），结构与字段保留。
默认走 **compact**（`full` 默认 false）：字段已清洗/摘要（如 href 去 token、ua 摘要、`data.response` 仅 code/message）。体积不够下结论时再对**窄条件**补 `full=true`。

## 两个引擎怎么选

| 引擎 | 工具前缀 | 定位方式 | 适用 |
|---|---|---|---|
| 日志中心（logcenter） | 无前缀（`query`/`count`/...） | 关键词搜服务 → `service_id` | 服务端应用日志，支持权限自检 |
| 云日志（阿里云 SLS） | `cloud_` 前缀 | 物理坐标 account → collection → topic | **三端（鸿蒙/安卓/iOS）技术日志、前端技术日志、未来云产品日志** |

- 云日志**没有业务名反查**：topic 只有物理坐标，找目标只能靠 `cloud_topics` 枚举后用 query 去撞，或直接用 `search_both_logs` 全量扫。
- 拿不准用哪侧时，一次 `search_both_logs` 并行撞两侧（见下）。用户日志常分布两侧：**禁止只查一侧就宣称覆盖完整**。

## 云日志（SLS）坐标

- 默认四元组由服务配置兜底，日常调用只需传 `topic` + `time` + `query`：
  account=`1743276692096170`，collection=`pysy-front-log`（前端日志集），region=`cn-beijing`，vendor=aliyun。
- **三端与未来云的 topic 集合需现场枚举**：调 `cloud_topics`（不带 collection 返回账号下全部 topic，每条自带 collection/region），按 topic 名识别鸿蒙/安卓/iOS/未来云各自的 topic 与所属 collection；跨 collection 时显式传 `collection`。
- `search_both_logs` 的云日志侧**固定扫默认 collection 下的 topic**，跨 collection 的目标请改用 `cloud_search` 单点查。

## 时间窗

- 用户给了事故时间 → **必须用该窗**，禁止擅自改成更宽/更窄的默认窗。
- **未给时间** → 默认 **`3d`**，并在回复中说明「未提供事故时间，已按近 3 天查询；若需更早或更窄窗请补充时间」。
- 相对窗写法见工具参数（含 `3d`/`7d`/`今天9:00到10:00` 等）；不要自造错误年份的绝对日期。

## 常用调用模式

1. **广撒网**：`search_both_logs(time, keyword 或 serviceId, query, cloud={})` —— 两侧并行、按 service/topic 分组，只返回有命中的；`scanned_*`/`matched_*` 告诉你全空还是只扫了一部分。**广撒网只为定位**：服务端已对超长字段/总量设预算（超限带 `logs_omitted`/`truncated`）。命中后改用 `cloud_search`/`query` 对目标精查，不要靠反复 search_both_logs 捞全文。
2. **动态扩展（正确率优先）**：先按命中相关度精查 Top 目标；若假设未证伪、线索指向其它 service/topic、或 `scanned_*`/`matched_*` 显示还有未覆盖目标，**继续扩查**，并在结论中写清已查范围。**不要**用「只精查 1～2 个 topic」硬顶赌覆盖。
3. **已知 topic 精查（云日志）**：首查用默认 compact（不传 `full` 或 `full=false`，默认 size 已收窄）。锁定窄条件（uid+事件/trace 等）后，若缺 stack/业务字段再对**同一窄条件**补 `cloud_search(..., full=true, size 宜小)`。**禁止首查就 full=true 灌上下文**；字段不够下结论时必须补 full/扩查，正确率优先于省 token。
4. **已知服务精查（日志中心）**：`search_services(关键词)` → 拿 `service_id` → `get_fields(serviceId)` 看可索引字段 → `query(serviceId, time, query)`（默认 compact）。
5. **先量后取**：用 `count`（日志中心，支持 query 过滤）或 `cloud_count`（**不支持 query**，只有 topic 总量）估计命中规模，再决定时间窗和条件。
6. **复杂聚合（日志中心）**：`dsl_search` 透传 ES Query Body（禁 script/script_fields，`from+size ≤ 10000`，始终全字段）。先用 `get_storage_type` 确认存储是 es 再写 DSL。

## 参数要点

- **分页两侧不同**：日志中心 `query` 用**页码**（page 从 1 起，每页固定 40 条）；云日志 `cloud_search` 用**偏移量**（from_ 从 0 起，size ≤ 1000）。dsl_search 也是偏移量语义。同窗翻页优先缩窗或加条件后再翻；禁止无条件空翻堆上下文。
- **`full`（云日志）**：默认 **false（compact）**。`search_both_logs` 的 cloud 侧默认也是 compact。需要完整条目时再显式 `full=true`。不要用 `| select *` 冒充全字段。
- **query 语法**：
  - 日志中心：Lucene。
  - 云日志：**默认关键词检索**（示例：学员 uid 裸数字、`uid and 事件名`）。`*` 表示不过滤。
  - **查人相关（登录/设备/学员行为）**：`query` **只用 uid 裸数字**（如 `5570040`）。禁止学员编号/card；不要写 `uid:5570040` / `card:…` 除非已确认该侧确有该字段。客户端线索必须带云日志（`search_both_logs(…, cloud={})` 或 `cloud_search`），只查日志中心常会假阴性；写「未登录」类结论前须双侧已查。
  - **禁止**日常排查写 `… | select *` / `select … from log`：这类 SQL 投影常把业务字段变成空/`null`，会被误判成「脱敏不可读」。只有明确要做聚合统计时才用 SQL，且失败或字段空时必须立刻改回普通关键词重查（必要时再 `full=true`）。
- **无 uid/trace/明确事件**：禁止 `*` / 弱词大 size 精查；先追问或 `count`。
- **`env`**：日志中心侧 prod/test，缺省=服务启动环境（本地 make 强制 prod）。线上事故不用传。

## 结果解读纪律

- 日志命中是观测证据：引用时保留 tool 返回的 ev-ID 与原始文本，注明 topic/service 与时间窗。
- `total > 0` 但页面没返回你要的条目 = 翻页/缩窗继续，不是"没有"。`total = 0` 且 `scanned_*` 覆盖完整才算"该时间窗无此日志"。
- 出现 `truncated` / `logs_omitted`：表示结果被体积护栏裁过，**不要假装已看完全量**；需要细节再窄查或 `full=true`。
- **`total > 0` 但每条几乎只有 `__time__`、业务字段全空**：多半是 query 用了 `| select …` 投影失败，立刻改用普通关键词重查；**不要**当成「脱敏导致不可读」而放弃。
- 查不到不等于没问题：采样、上报失败、时间窗错位都可能造成空结果，结论里如实写明查询覆盖范围。
- 工具整组不可用（本轮没有 `cloud_*`/`query` 等工具）说明 log-mcp 本轮未挂入，如实告知"线上日志通道不可用"，不要虚构日志内容。
- **禁止用体积规则否证业务结论**：不得因「为省 token 只查了云 / 只用了 compact」就写未登录或根因。
