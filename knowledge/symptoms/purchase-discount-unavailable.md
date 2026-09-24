---
name: purchase-discount-unavailable
kind: symptom
symptom: 优惠券或优惠价格不符合预期
aliases:
- 有券用不上
- 联报折扣没有
- 优惠活动不生效
domains:
- order
- payment
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 优惠券或优惠价格不符合预期

## 候选链路

- [[coupon-unavailable-reasons]]：优惠券为什么用不了
- [[promotion-coupon-rules]]：优惠券与优惠活动的规则

## 区分它们需要什么

是找不到券、选择后被拒，还是活动价未生效？依次收集券状态与归属、学员资格、商品范围、金额；活动另核对开班与版本名、改名时间及互斥组合。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
