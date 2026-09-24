---
name: class-selection-display
kind: symptom
symptom: 选课列表信息显示异常
aliases:
- 课态标签不对
- 年级不对
- 时间选项不对
- 教室号不显示
- 附近5km没有
domains:
- learning
- order
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 选课列表信息显示异常

## 候选链路

- [[class-time-option-aggregation]]：上课时间选项是怎么来的
- [[class-location-display]]：班级地点只展示到教学点
- [[online-lesson-in-offline-class]]：面授 / 托管班里的「在线课次」
- [[platform-visibility-matrix]]：各端的班级漏出矩阵
- [[class-mode-vs-interaction-mode]]：班课的两个「模式」字段（极易混）
- [[nearby-teaching-point-filter]]：选课的「附近 5km」筛选
- [[course-grade-projection]]：投放年级的计算规则
- [[coursestate-mapping]]：课态（班级卡片上的标签）

## 区分它们需要什么

具体异常的是时间、地点、年级、课态还是列表可见性？拿到端、业务归属、授课类型和课程/班级 ID。时间核对逐课次；附近筛选核对定位与列表教学点；年级核对学期及系统升年级日期。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
