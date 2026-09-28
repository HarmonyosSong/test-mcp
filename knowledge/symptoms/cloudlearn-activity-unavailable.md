---
name: cloudlearn-activity-unavailable
kind: symptom
symptom: 云学习任务打不开
aliases:
- 口语岛异常
- 绘本无法评测
- 朗读没有评分
- 磨耳朵打不开
- 没有分数
- 无分数
- 空分数
domains:
- cloudlearn
applies_to:
- harmony
authority: auto
updated_at: 2026-09-28
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 云学习任务打不开

## 候选链路

- [[cloudlearn-terms-vs-user-words]]：用户怎么说 ≠ 云学习叫什么
- [[cloudlearn-h5-surfaces]]：云学习 H5 在 xesapp 里的挂载面
- [[classlearn-spoken-island-entry]]：语音评测：单入口，四链路
- [[classlearn-h5-bridge-contract]]：云学习 H5 与 xesapp 的 JSBridge 契约

## 区分它们需要什么

是新做任务、我的作品回看、分享作品还是绘本？记录入口和 fromTask，先用术语表确定 H5 页面，再区分站点环境、原生跳转和 JSBridge 调用失败；作品回看不能当新评测。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
