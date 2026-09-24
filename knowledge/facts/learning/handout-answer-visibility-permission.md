---
name: handout-answer-visibility-permission
domains: [learning, account]
kind: platform-fact
applies_to: [harmony]
authority: code
updated_at: 2026-09-22
verified_at: 2026-09-22
description: 电子讲义的答案解析可由家长在「我的-设置-权限设置」里开关，默认开启、按学员ID存储；关闭后讲议里展开答案会弹窗指路
aliases:
  - 讲义里点不开答案
  - 展开答案没反应
  - 电子讲义没有答案解析
  - 讲义答案看不到
  - 设置答案展示权限
  - 权限设置在哪
  - 讲义不给看答案
---

# 电子讲义答案解析的显示权限

## 事实

电子讲义的答案解析**是否展示由家长自己控制**，默认开启：

- **入口**：我的 → 设置 → **权限设置**（仅登录态展示）；
- **开关**：`电子讲义答案开启权限`，副标题「关闭后，电子讲义将不展示答案解析」；
- **默认值**：**开启**；
- **存储**：按**学员 ID** 云存储——状态跟学员走，不跟设备走；
- **关闭后的表现**：在讲义详情页点【展开全部答案】【单题展开答案】会弹窗，
  标题「设置答案展示权限」，正文「请前往学而思APP-我的-右上角设置-权限设置调整权限」，
  点「我知道了」中止展开动作。

设计起因：高中用户**课前**查阅讲义时看到答案会影响课中学习效果。此前只能靠教研上传「有答案 / 无答案」
两份讲义、再配不同的解锁时间来绕，效率低；现在改为用户可控。

代码位置（鸿蒙侧）：

| 环节 | 文件 |
| --- | --- |
| 设置页（权限设置入口） | `XesMine/src/main/ets/components/settings/pages/SettingsPage.ets` |
| 权限设置页（本开关所在） | `XesMine/src/main/ets/components/settings/pages/PermissionSettingPage.ets` |

## 判据

用户说「讲义里点不开答案 / 展开答案没反应」时：

1. **先查权限设置里的开关**——大概率是被关过（家长自己关的，或多人共用同一学员账号）；
2. 关闭态的表现是**弹窗指路**而不是静默失败：用户如果提到"弹了个框让我去设置"，就直接对上了；
3. 这个状态**跟学员 ID 走**，不是跟设备走，换手机不会重置。

## 例外

- 需求覆盖学而思 APP / HD、学家云 APP / HD、学而思 Steam APP（原文写 iOS & Android）；
- **「权限设置」页不止这一个开关**（问"权限设置里没有 XX 开关"时先对这份清单）：
  同页还有「**学生端免密登录**」（见 [[face-recognition-login-permission]]）、
  「**个性化推荐服务**」（见 [[learning-data-sharing-switch]]）、
  「**小思AI / 蛋君**」（见 [[xiaosi-ai-permission-switch]]），
  以及从设置页迁过来的「**种树功能管理**」；

## 来源

- 《【20240925】学而思/学家云APP-权限设置-讲义答案解析开关》知音楼 `https://s.tal.com/a/DMTmwk`（2026-06-01 更新）
  ——该页本身只是**传送门**，实质内容在下面这篇：
- 《素养/高中APP_电子讲义答案解析显示控制_v1.0.240925》知音楼
  `https://yach-doc-shimo.zhiyinlou.com/docs/VMAPVQjpBoFpRbqg`（2024-08-05，刘东）
- 均为**人工核实入口，agent 无访问能力**。

**客户端代码核对结果**（仓库 `xesapp`，分支 `releaseV/20260921`，2026-09-22）：
「电子讲义答案开启权限」命中 `XesMine` 的 `PermissionSettingPage.ets` 四处；
设置页与权限设置页都在 `XesMine/src/main/ets/components/settings/pages/` 下。
