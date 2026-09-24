---
name: checkout-entry-blocked
kind: symptom
symptom: 付款跳转或确认按钮受限
aliases:
- 顾问二维码付不了
- 数字货币协议倒计时
- 开课须知确认
domains:
- order
- payment
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 付款跳转或确认按钮受限

## 候选链路

- [[pangu-qr-payment]]：盘古扫码支付（二维码为什么老出问题）
- [[shenzhen-digital-currency-protocol]]：深圳数字人民币订单的协议交互
- [[course-notice-confirmation]]：购课前的「开课须知」确认

## 区分它们需要什么

来自盘古二维码、深圳数字货币订单，还是开课须知？记录原始入口、是否截图扫码、分校与完整提示。倒计时和扫码风控要分开；开课须知条目尚未实现，必须核对当前代码。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
