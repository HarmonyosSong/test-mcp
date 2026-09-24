---
name: trial-payment-refund
kind: symptom
symptom: 先上课后缴费或退费异常
aliases:
- 体验后缴费
- 自学课退款
- 先学后付课程消失
domains:
- learning
- order
- payment
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 先上课后缴费或退费异常

## 候选链路

- [[trial-class-pay-after-satisfaction]]：先满意再缴费（trialClass）
- [[learn-first-pay-later]]：先学后付（学习模块侧）
- [[self-study-course-refund]]：自学课的退费规则

## 区分它们需要什么

是先满意再缴费、先学后付，还是自学课退费？记录 trialClass、付款/撤单状态、已上课次和解锁方式，先分清产品机制再核对调课、任务消失或退款范围。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
