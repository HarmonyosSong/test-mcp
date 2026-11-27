---
name: cmb-pay-not-launching
kind: symptom
symptom: 招行支付点了没反应，拉不起招行 App
aliases:
  - 招行支付没反应
  - 招商银行支付失败
  - 选择招行支付没跳转
  - 招行一网通付不了
  - 招行支付不唤起
domains:
  - payment
applies_to:
  - android
authority: internal-sop
updated_at: 2026-11-27
verified_at: 2026-11-27
description: 已确认案例：壳工程 <queries> 未声明招行包名，SDK 安装检测恒 false 静默走 H5 兜底
---

# 招行支付点了没反应，拉不起招行 App

## 候选链路

- [[cmb-sdk-install-check]]：招行 SDK 用包枚举检测安装状态，壳工程 `<queries>`
  未声明 `cmb.pb`，targetSdk 30+ 下检测恒 false，静默走 H5 兜底、无任何提示
  （2026-11 已确认案例，安卓 7.106.0）。

## 区分它们需要什么

1. **哪个端**——已确认案例仅安卓；iOS/鸿蒙拉起链路不同，先排除套用本条目；
2. **有无任何提示**——「点了完全没反应、无报错」是包可见性链路的特征；
   有 toast/错误页则更可能是支付参数或 SDK 调用问题；
3. **版本与 targetSdk**——宿主 targetSdk≥30 才命中 [[android-package-visibility-queries]]。

## 注意

「无报错」容易误判为「用户操作问题」或「网络问题」；这条链路的本质恰恰是
**设计上就没有报错路径**（SDK 静默兜底）。若 `<queries>` 已补声明仍复现，
需重新核实，不能直接套用本结论。
