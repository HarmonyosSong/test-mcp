# 技术决策记录

当前产品 Agent 与 HTTP 请求路径由 Mastra TypeScript Runtime 承载，旧 Python Agent/FastAPI 源码已删除。下列 ADR 仍定义证据、知识和成本策略，其中旧路径和旧测试数字属于决策形成时的上下文；当前实现见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)（编排层已随 0004 退役，旧编排设计仅作历史参考）。

一个决策一篇，ADR 轻量格式：背景 → 考察过的选项 → 决策 → 触发条件 → 验收。
决策一旦记录不删改；被推翻时新写一篇并在旧篇标注 superseded。

> **例外**：0001 于 2026-09-22 由「知识库选型」就地改写为「文档入库筛选条件」。
> 选型结论已落进 `knowledge/` 的实现，而团队当下更需要的是入库时的筛选约束，故改写而非另起一篇。
> 被删去的选型考察（OpenViking / 经典 RAG / 免策展 RAG 对比）未进过 git（`docs/decisions/` 当时未跟踪），
> 改写前原文备份在 `/tmp/0001-original-20260920.md`。

## 索引

| 编号 | 日期 | 标题 | 状态 |
| --- | --- | --- | --- |
| [0001](0001-knowledge-base-selection.md) | 2026-09-22 | 文档入库筛选条件（原「业务知识库选型」，2026-09-20 改写） | 生效 |
| [0002](0002-runtime-knowledge-budget.md) | 2026-09-23 | Runtime、Skill 与知识检索的成本和证据约束 | 生效 |
| [0003](0003-evidence-ledger-lifecycle.md) | 2026-09-29 | 观测证据生命周期与工具缓存一致性（替代 0002 的 120 条 FIFO 约定） | 部分生效（淘汰/墓碑/提交契约由 0004 取代，ev-ID 哈希与缓存一致性原则仍生效） |
| [0004](0004-deorchestration.md) | 2026-11-17 | 去编排化——单 loop Agent + 工具封装 + 横切护栏（退役 Supervisor/阶段管线/报告工具契约） | 生效 |
