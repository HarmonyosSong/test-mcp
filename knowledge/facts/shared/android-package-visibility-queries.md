---
name: android-package-visibility-queries
domains: [shared]
kind: platform-fact
applies_to: [android]
authority: official
updated_at: 2026-11-27
verified_at: 2026-11-27
description: targetSdk≥30 后包可见性生效：未在 manifest <queries> 声明的三方包对包枚举/查询不可见，SDK 的「App 是否已安装」检测会恒判未安装
aliases:
  - 包可见性
  - queries 声明
  - 检测不到已安装的 App
  - 判断 App 是否安装失败
  - getInstalledPackages
  - 拉不起三方 App
---

# Android 11+ 包可见性与 `<queries>` 声明

## 事实

targetSdk≥30（Android 11 起）后，应用默认只能看到自己与少数系统包：
`PackageManager.getInstalledPackages()` / `getApplicationInfo()` 等枚举与查询接口，
对未在自身 `AndroidManifest.xml` 的 `<queries>` 段声明的包名**一律表现为「未安装」**，
不抛异常、无任何日志特征。

影响面：所有「先检测三方 App 是否安装、再决定拉起或走兜底」的三方 SDK
（支付、地图、分享、登录类）。检测恒 false 时 SDK 通常静默走 H5/网页兜底分支，
用户感知是「点了没反应」而非报错——**无报错本身就是这条链路的特征**。

## 判据

1. 查壳工程 `AndroidManifest.xml` 的 `<queries>` 段：目标包名（或对应 intent/action）
   是否声明；只声明 package 不够时还需核对 SDK 实际使用的查询方式；
2. 查 SDK 的安装检测实现：jar 可直接读 class，aar 需反编译（如 jadx），
   确认是否基于包枚举/包查询；
3. 宿主 targetSdk≥30 才受影响；SDK 自身老旧（targetSdk 低）不免除——
   过滤按**宿主** targetSdk 执行。

## 例外

- `<queries>` 里声明 `<intent>` 或 `<provider>` authority 同样能获得可见性，
  不是只有 `<package>` 一种写法；
- 显式 intent 拉起（`startActivity` 指定包名）不受包可见性限制，
  受影响的只是「检测/枚举」类接口。

## 来源

- Android 官方文档《软件包可见性》（Android 11 行为变更）。
- 线上案例：招行支付拉不起招行 App（2026-11，见 [[cmb-sdk-install-check]]）。
