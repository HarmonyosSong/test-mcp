---
name: course-change-restricted
kind: symptom
symptom: 调课转班或续报不符合预期
aliases:
- 后面几节课时间变了
- 不能取消订单
- 不能换商品
- 跨业务线续报
domains:
- learning
- order
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 调课转班或续报不符合预期

## 候选链路

- [[class-reschedule-cascade]]：调课引起的课次顺延与短信口径
- [[one-on-one-order-restrictions]]：1对1 订单的几处刻意限制
- [[renewal-cross-business-line]]：续报能不能跨业务线
- [[course-swap-restrictions]]：换商品 / 转班的支持范围

## 区分它们需要什么

用户做的是调课、转班、换商品、续报还是取消订单？记录前后班型、课次数、分期数与业务线；逐课次比对时间，区分调课顺延和转班范围限制。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
