---
name: appraisal-unavailable
kind: symptom
symptom: 评价不能提交或删除
aliases:
- 评论发不出去
- 个人评价管理
domains:
- learning
- shared
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 评价不能提交或删除

## 候选链路

- [[personal-appraisal-management]]：个人评价管理
- [[appraise-sensitive-word-block]]：评价触发的敏感词拦截

## 区分它们需要什么

是提交被风险文案拦截，还是历史评价不能删？收集完整提示或 can_delete 返回值；不要从客户端入口推断服务端敏感词规则。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
