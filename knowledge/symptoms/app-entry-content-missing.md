---
name: app-entry-content-missing
kind: symptom
symptom: 我的页消息或首页内容缺失
aliases:
- 消息卡片不对
- 首页弹窗消失
- 我的班级在哪
domains:
- shared
applies_to:
- android
- harmony
- ios
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 我的页消息或首页内容缺失

## 候选链路

- [[message-types-catalog]]：消息类型清单
- [[my-page-entries]]：「我的」页面的入口结构
- [[resource-slot-class-expiry]]：资源位 / 弹窗的班级过期机制

## 区分它们需要什么

是我的页固定入口、消息类型/卡片，还是按班级投放的资源位？记录卡片类型和班级 ID；先区分入口改版、已废弃消息类型与班级过期下架。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
