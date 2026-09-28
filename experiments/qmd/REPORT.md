# QMD 混合检索试点报告（2026-09-24)

QMD 2.8.3 + Qwen3-Embedding-0.6B(Q8)+ qwen3-reranker-0.6b(Q8)，全程 CPU(`QMD_FORCE_CPU=1`,Metal 未验证)。
语料：knowledge/ 89 条（facts 65 + symptoms 24)，评测 34 查询（regression 12、extra_rewrite 6、
pilot_rewrite 10（全新改写，未进别名）、negative 6（无关查询应零命中）)。数据与原始结果：
`.data/qmd-pilot/{fixtures.json,results-all.json}`。

## 环境两个坑（已修，run.mjs 内注）

1. **首次"卡死"是静默编译**：无 CPU 预编译包时 node-llama-cpp 现场 cmake(~2 分钟），
   QMD 把 native stdout 重定向吞掉了，看起来像死锁。编译产物在
   `node_modules/node-llama-cpp/llama/localBuilds/`，之后秒级。
2. **QMD 2.8.3 缺陷**：`chunkDocumentByTokens` 硬编码走 `getDefaultLlamaCpp()` 单例
   （store.js:2449），无视 `config.models`——单例只读环境变量，默认去 HuggingFace 拉
   embeddinggemma，网络挂起即"卡死"。修法：设 `QMD_EMBED_MODEL` / `QMD_RERANK_MODEL`
   指向本地 GGUF（单例与实例用同一模型，tokenizer 一致，无副作用）。
   接入生产前应向 QMD 提 issue 或在适配层显式处理。

## 三种模式对比（召回@3；negative 为无关查询）

| split(n) | 现有检索 | bm25 | vector | hybrid | rerank |
|---|---|---|---|---|---|
| regression(12) | **12** | 9 | 11 | 11 | 11 |
| extra_rewrite(6) | **6** | 0 | 6 | 6 | 6 |
| pilot_rewrite(10) | 3 | 1 | **10** | **10** | **10** |
| negative(6) 误放 | 0 | 0 | 0* | 0* | 0* |

\* 模式本身无阈值概念；能否拦负样本取决于接入层阈值，见下。

- **bm25 中文残废**：依赖词边界，extra_rewrite 0/6。lex 一路对中文语料基本无贡献。
- **vector 是唯一增量**：pilot 3→10；regression 11/12（丢「买课时找不到签约入口」——
  aliases 里的字面说法被向量语义稀释，现有检索靠别名精确命中，必须保留）。
- **hybrid 分数失真**：RRF 融合让 negative 6 条 top-1 全部 1.000，排名分不能当置信度；
  且召回与 vector 完全一致，无增量。
- **rerank 无质量增量**(pilot 与 vector 完全一致，候选集只有 ≤20 条），CPU 延迟
  p50 76s/查询，不可在线用。负样本上 cross-encoder 给 0.75 分，其绝对分同样不能当阈值。

## 延迟与资源（CPU）

| 项 | 值 |
|---|---|
| 现有检索 | p50 20ms |
| vector 查询 | p50 79ms,p95 118ms |
| hybrid 查询 | p50 78ms（与 vector 相同路径） |
| rerank 查询 | p50 76s —— 在线不可用 |
| 索引更新(89 条无变化) | 43ms |
| 首次 embedding(89 文档) | 314s（一次性；Metal 可用后应分钟级） |
| 峰值 RSS(双模型常驻+索引) | 3.1GB |

## 关键决策数据：vector 分数正/负分离度

正样本期望条目最低分 0.459 / 0.493 / 0.520；负样本 top-1 最高 0.508。
**[0.46, 0.51] 重叠，不存在干净阈值**——所以 vector 不能单独成路，必须和现有检索分层：

## 推荐生产规则（模拟结果）

> 现有检索 top1 ≥ 2.7（短语/包含级）直通；否则 vector ≥ 0.52 优先、现有弱命中补充。

| 规则 | regression | extra | pilot | 总 | 负样本误放 |
|---|---|---|---|---|---|
| 现有单独 | 12/12 | 6/6 | 3/10 | 21/28 | 0/6 |
| **分层规则(0.52)** | 12/12 | 6/6 | **9/10** | **27/28** | **0/6** |

唯一漏网：「孩子没做题就能展开标准解法」期望条即 vector top-1，但 0.49 落在不可分离区。
属于阈值固有代价，第一版不为它放宽（放宽即放进负样本）。

## 接入建议（对应原计划四步）

1. **索引**：收 facts/、symptoms/（维护说明天然不在其中）；规范 ID = 文件 basename；
   删除条目时 `store.update()` 会移除（43ms 增量）。
2. **lookup_issue 适配**：现有 search() 强命中直通；弱/无命中走 vector 召回 →
   阈值 0.52 → 按 file 还原规范 ID → 现有 loader 补齐 authority/适用范围/引用/正文预览
   → SearchHit(score 用 vector 原始分，matched_on 标 `vector:`)。leads_only、end/version
   降权、domain tie-break 在适配层重放，语义不变。
3. **索引更新**：启动时 update+embed；`knowledge_feedback apply` 落库后触发同一入口；
   删除条目随 update 同步。
4. **故障回退**：vector 调用超时建议 500ms(p95 的 4 倍)，失败/超时回退现有检索
   （现状行为）。rerank 第一版不进在线路径。模型常驻（QMD 自带 `dist/mcp/server.js`，
   可以 sidecar MCP 形态接入，与现有 MCPToolset 架构一致）。

## 遗留

- Metal 路径未验证（本机 Metal 初始化曾挂起，未深挖）；GPU 可用后 embed/rerank 提速再评估。
- 阈值 0.52 来自 34 条小样本，接入后需在 querylog 里盯 `vector:` 命中分布校准。
- QMD_EMBED_PARALLELISM=1 下 embed 4 线程推理；生产 sidecar 需限定 CPU 预算。
- 新改写测试纪律保留：pilot_rewrite 的问法不进 aliases，作为长期回归集。
