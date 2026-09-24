---
name: invoice-unavailable
kind: symptom
symptom: 开票入口不可用
aliases:
- 发票开不出来
- 退费后开票
domains:
- invoice
- order
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 开票入口不可用

## 候选链路

- [[c-end-invoice-pilot-subject]]：C 端开票：试点主体与按钮展示规则

## 区分它们需要什么

先核实功能是否实际已上线，再核对主体、开课月份及退费/转班状态。条目仍记载未上线，不能把规划中的按钮规则当成线上根因。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
