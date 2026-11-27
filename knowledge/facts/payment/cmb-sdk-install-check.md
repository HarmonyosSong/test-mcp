---
name: cmb-sdk-install-check
domains: [payment]
kind: mapping
applies_to: [android]
authority: code
updated_at: 2026-11-27
verified_at: 2026-11-27
description: 招行 SDK（cmbsdk）用包枚举检测招行 App 是否安装；壳工程 <queries> 未声明 cmb.pb，targetSdk 30+ 下检测恒 false，静默走 H5 兜底、无任何提示
aliases:
  - 招行支付
  - 招商银行
  - 招行一网通
  - cmb
  - cmb.pb
  - 招行 App 拉不起来
  - 招行支付点了没反应
---

# 招行支付链路：SDK 安装检测与包可见性缺口

## 事实

学而思安卓收银台选择「招行一网通」（payType=104）后的链路：

1. `CheckstandActivity`（purchase 组件）选中招行后**无条件**调 `payTrade()`——
   对比支付宝分支有 `isAliPayInstalled()` 前置判断，招行分支自身不做任何安装检测，
   检测完全交给招行 SDK；
2. 招行 SDK `purchase/libs/cmbsdk-release-1.1.0.aar`（2019-11 构建）的
   `isCMBAppInstalled()`（反汇编位于 `cmbapi/a.class`）用
   `PackageManager.getInstalledPackages(0)` 枚举已安装包、比对包名 `cmb.pb`；
3. 壳工程 `AndroidManifest.xml` 的 `<queries>` 只声明了高德/百度/腾讯三个地图包，
   **未声明 `cmb.pb`**；宿主 targetSdk≥30（当前 34）后包可见性生效
   （见 [[android-package-visibility-queries]]），枚举结果永远不含招行；
4. 检测恒 false → SDK 静默走 H5 兜底分支 → 招行 App 从未被拉起，
   **用户看不到任何报错**，现象就是「点了没反应」。

注意：SDK 是 2019 年构建的老包，自身从未改版——是宿主 targetSdk 升级后
被平台行为变化击中。同类风险面：所有用包枚举做安装检测的三方 SDK。

## 判据

线上问题怀疑这条链路时，按序核实：

1. 壳工程 `AndroidManifest.xml` 的 `<queries>` 段是否含 `cmb.pb`（缺失即命中）；
2. 现象是否「点了没反应、无任何提示」——有报错提示则更可能是别的链路；
3. 需要确定性证据时反编译 aar 确认 `isCMBAppInstalled` 实现
   （jadx 打开 `purchase/libs/cmbsdk-release-1.1.0.aar`，查 `cmbapi` 包）。

## 例外

- 仅安卓端受此缺口影响；iOS/鸿蒙的招行拉起链路不同，不适用本条目；
- 若后续版本在 `<queries>` 补声明了 `cmb.pb`，本缺口即修复，
  再发「拉不起」需重新核实其他环节（SDK 版本、招行 App 自身）。

## 来源

- 2026-11 线上案例：学而思 App 安卓端 7.106.0 招行支付拉不起招行 App，
  结论经反编译 aar 字节码核实，用户确认结论正确。
