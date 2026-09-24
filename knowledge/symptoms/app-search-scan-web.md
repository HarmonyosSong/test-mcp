---
name: app-search-scan-web
kind: symptom
symptom: 搜索扫码或网页打开异常
aliases:
- AI搜索不准
- 扫码提示未加密
- 同一网页两端不同
domains:
- shared
applies_to:
- harmony
authority: auto
updated_at: 2026-09-24
description: 依据既有事实组织的候选入口，尚待真实案例验证
---

# 搜索扫码或网页打开异常

## 候选链路

- [[app-search-behavior]]：App 搜索：词类分布与已知问题
- [[scan-feature-and-http-block]]：扫一扫：支持的端与 http 拦截
- [[h5-runtime-context-injection]]：H5 靠原生注入判断自己在哪

## 区分它们需要什么

是搜索无结果、扫码被拦，还是同 URL 在不同容器表现不同？分别收集查询词、扫码协议、页面 URL 与 UA/cookie 注入；不要把搜索召回问题归因于 H5 桥接。

## 注意

本入口由既有条目组织，不代表发生频率或已确认根因。候选的版本、来源与例外以引用条目为准，须结合当前代码、日志或接口观测核实；不能将未上线或旧版本规则直接用于当前问题。
