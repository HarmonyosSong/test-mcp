---
name: account-permission-effects
kind: symptom
symptom: 权限关闭后仍然生效
aliases:
- 第三方应用授权
- 免密登录不可用
- 个性化推荐开关
domains:
- account
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 权限关闭后仍然生效

## 候选链路

- [[app-authorization-management]]：应用授权管理（第三方数据打通）
- [[learning-data-sharing-switch]]：学情数据共享开关
- [[face-recognition-login-permission]]：课堂人脸采集与免密登录授权

## 区分它们需要什么

操作的是应用授权、个性化推荐，还是学生端免密登录？核对登录账号和关联学员，以及关闭前后的实际请求；入口仍在与授权仍有效是两件事。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
