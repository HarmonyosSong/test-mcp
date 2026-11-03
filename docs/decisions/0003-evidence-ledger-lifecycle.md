# 0003:观测证据生命周期与工具缓存一致性

> 本 ADR 的证据生命周期和缓存原则仍生效；文中 `agent/tests` 与 Python 类名是历史验收上下文。当前 TypeScript 实现位于 `runtime/src/diagnosis/evidence.ts` 和 `runtime/src/diagnosis/agent.ts`，当前测试位于 `runtime/test/`。

2026-09-29。依据 [运行时工具效率实施方案](../runtime-tool-efficiency-implementation-plan.md)
阶段 A,替代 [0002](0002-runtime-knowledge-budget.md) 中「上限 120 条 FIFO 淘汰」的
单一约定(0002 第 32-33 行);0002 其余约束仍然有效。触发事件:53 步会话中早期证据被
FIFO 挤掉、复用响应不含证据 ID、模型编 ID 提交报告三连失败
(审计:experiments/runtime_audit/REPORT-2026-09-28-conv-1d1e339323.md)。

## 证据账本淘汰分两层

- **历史容量是软目标**(默认 300 条):超额时只淘汰最旧的**非本轮**观测;
  本轮已交付模型的观测受保护,不被历史容量挤掉——报告引用本轮早期 ID 始终有效。
- **本轮硬上限**(默认 1000 条 / 4 MiB 文本,`max_current_turn` / `max_current_turn_bytes`):
  达到即停止接纳新观测。admission 在返回 `evidence_refs` 之前完成;
  拒绝时返回 `observation_capacity_reached` 标记,该行观测不产出 ID,
  绝不向模型返回无法引用的引用。

## 被淘汰 ID 与伪造 ID 不再混为一谈

- 淘汰留墓碑(id → 原观测位置),随快照跨轮持久化;
  引用被淘汰 ID 返回 `expired` + 原位置,引用从未出现的 ID 返回 `unknown` + 可用清单。
- 证据 ID 是内容哈希(工具、参数、位置、原文):重读同位置同内容恢复同一 ID,
  墓碑自动消除并计 `restored_count`——「恢复」不需要另建存储层。
- USER 证据不进观测账本:校验摘录必须是用户消息原文(防编造"用户没说过的话"),
  且正向候选校验必须容忍 USER ID 存在(用 `entries.get`,直接索引会裸抛 KeyError)。

## 工具调用缓存是记录,不是序号

`_cache: 签名 → CachedCall(call_index, snapshot_generation, evidence_refs)`,替代旧的两张表:

- 签名先补工具默认参数再规范化(默认值表与工具定义同步维护),省略默认与显式同值归一。
- `bind_repository` 按返回文本里的 commit 判快照:**同 commit 重绑幂等不清缓存**;
  换 commit 或提取不到 commit 时才失效缓存与进度状态。
- 复用前核对缓存的证据引用仍在账本;已被淘汰则缓存失效,允许一次真实重读,
  恢复成功计 `evidence_restored` 且不计入无进展——不能既阻止重读又要求引用失效 ID。

## 验收

`agent/tests/test_runtime_efficiency.py` 与 `test_tool_failure_budget.py` 覆盖:
本轮观测超历史容量仍可引用;硬上限拒绝接纳不产出 ID;过期/伪造 ID 错误细分;
淘汰后重读恢复同 ID;缓存证据失效回退真实重读;默认参数归一;同 commit 幂等绑定。
方案 B-E 阶段(分页协议、引用式报告、计量口径、真实对照)不在本 ADR 范围。
