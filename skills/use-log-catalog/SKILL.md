---
name: use-log-catalog
description: Resolve business log targets from the built-in catalog and query Aliyun SLS product events or 未来云日志中心 client APM. Use when the user asks about remote product/app logs and log tools are available; not a substitute for pasted hilog or source evidence.
metadata:
  version: "0.2.0"
  stage: investigate
  modes: [chat]
  required_tools: [resolve_log_target, count_cloud_logs, search_cloud_logs, count_logs, query_logs]
---

# Use Log Catalog

Optional dual-source capability. Catalog is **appid/target-first** (v3): resolve a `target`, then use
coords/`suggested_query` from config—do not invent account/topic/service_id or hardcode filters.

- **`aliyun_sls` + `product_event`**：埋点按 **appid** 区分；`prod-ios` 物理库上同时有 iOS 与鸿蒙 appid
- **`logcenter` + `client_apm`**：培优客户端 APM（service_id）

This Skill only appears when the five log tools are mounted. Results are investigation helpers, **not**
root-cause proof in this phase.

## When to use

- Remote product/app logs (口语岛、磨耳朵、装扮商城、安卓/iOS **埋点**或 **APM 监控**) and tools are available.
- Prefer local `parse_hilog` when the user already pasted hilog text.
- Not a mandatory step in every diagnosis turn.

## Resolve first

1. Call `load_skill("use-log-catalog")` before the first log tool call that needs remote logs.
2. Call `resolve_log_target` with a short query from the user's wording.
3. Interpret `status`:
   - `resolved`: use the single candidate; branch on `source` (below).
   - `ambiguous`: ask **one** clarifying question. Common splits: **埋点 vs APM**；**鸿蒙 vs iOS**（可同属 prod-ios store）；Pad vs 手机；装扮商城 vs 播放器等 appid. Do not search a guess.
   - `not_found`: say the catalog does not cover the request; never invent service_id or SLS account/topic.

## Route by `source`

### `source=aliyun_sls`（产品埋点）

4. Prefer `count_cloud_logs` when volume is uncertain, then `search_cloud_logs`. 注意：上游 `cloud-count` **不支持 query**；有 appid/uid 过滤时 Runtime 会改用 `cloud-search` 的 total。若返回里带 `filtered:true`，以该 total 为准；上亿级且无 `filtered` 才是未过滤的 topic 总量。
5. Pass resolved `vendor`, `region`, `account`, `collection`, `topic`, and prefer `suggested_query` (appid + match fields). Runtime 若已解析到学员 uid，会自动 AND `uid:"<id>"`；查单个用户时应用 `search_cloud_logs` 看正文，不要只靠未过滤的 count 下结论。

### `source=logcenter`（客户端 APM）

4. Prefer `count_logs` then `query_logs` with resolved `service_id`.
5. Prefer catalog `suggested_query` (e.g. `c.monitorLogType:1` for network). `query_logs.page` starts at **1** (page number, not offset). Keep size ≤ 40.
6. Use `client_form` / `app_clientid` / `monitor_types` from the candidate to refine filters; do not call SLS cloud tools for these targets.
7. **学员编号 ≠ uid（Runtime 自动处理）**：本轮若已识别到学员编号/用户数字，Runtime 会在挂载日志工具时转成 uid，并在 `count_cloud_logs` / `search_cloud_logs` / `count_logs` / `query_logs` **强制 AND** `uid:<id>`。不要向用户索要“请先把编号转成 uid”；也不要把 12 位学员编号手写进 `uid:`。若计数仍是上亿级全库量，说明 uid 过滤没生效，应改用带用户身份标签的原文或明确写 `uid: <数字>` 后再查，而不是让用户手动换算。

## Boundaries

- Do not call cloud account/collection/topic listing APIs; expand the catalog instead.
- Do not treat empty search results as proof that an incident did not happen.
- Vague「安卓日志」/「iOS日志」without 埋点 vs 监控 → ask; catalog may return ambiguous across sources.
- If tools are unconfigured or fail with permission errors, report the gap and continue with other evidence.
