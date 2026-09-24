---
name: classlearn-h5-bridge-contract
domains: [cloudlearn]
kind: mapping
description: 云学习 H5 与 xesapp 之间的 JSBridge 契约——handler 名字即跨仓库接口，注册点分散在三处
applies_to: [harmony]
authority: code
updated_at: 2026-09-17
verified_at: 2026-09-17
aliases:
  - JSBridge
  - h5 调用原生没反应
  - H5 调原生失败
  - handler 没生效
  - 原生能力
  - xesApp_nativeAbility
  - 桥接失败
---

# 云学习 H5 与 xesapp 的 JSBridge 契约

云学习 H5 的录音、上传、播放、任务提交、拍照这些能力**都不在 H5 里**，而是通过 JSBridge
调用 xesapp 的原生实现。handler 的**名字就是接口**。

**这是跨仓库契约**：调用方在云学习前端仓库，实现方在 xesapp。改一个名字，在本仓库 grep 只能
看到一半的爆炸半径——另一半不在这个仓库里，必须先确认 H5 侧是否同步。这条是本条目存在的理由，
逐条列举 handler 不必要：那些名字在 `XesWebView` 源码里，随时可以查，而且会过期。

## 注册点有三处，查"没生效"必须三处都看

| 文件 | 承担 |
| --- | --- |
| `XesWebView/src/main/ets/components/RegisterHandlerUtil.ets` | 全 App 通用能力（约 70 个）：登录态、标题、loading、弹窗、toast、网络状态、跳转、埋点 |
| `XesWebView/src/main/ets/components/Xeswebview.ets` | 容器层注册的教学 / 云学习能力：录音、音频播放、视频、上传、任务提交、互动游戏 |
| `XesWebView/src/main/ets/components/RegisterHandlerForCloudStudy.ets` | 云学习专属：目前只有相册选择，另有 `getNativeinfo` 作为被调用的数据组装方法（不是 handler） |

**同一个 handler 名可能在多处注册**，生效的是容器层那一次。只看云学习注册类会得出"能力不存在"
的错误结论——那里有若干条注册被注释掉了，同名实现其实在 `Xeswebview.ets` 里已经注册。
判断能力是否存在，**在 `XesWebView` 全模块搜 handler 名字**，不要只看某一个文件。

## 能力分组（按用户会说的现象分）

- **录音与上传** —— "录不上音"、"录音没反应"、"音频传不上去"
- **音频播放** —— 磨耳朵类问题；播放器有独立的状态机，播放态与页面生命周期耦合
- **视频与投屏** —— "视频打不开"、投屏
- **拍照 / 相册 / 上传图片** —— "拍照上传失败"
- **任务与评测回传** —— H5 通知原生的提交结果，只用于通知，不参与判定
- **页面控制** —— 标题、返回、横竖屏、loading、弹窗
- **设备与用户信息** —— H5 启动时向原生拉取用户、设备、环境信息

## 判据

**区分"原生没实现"和"原生实现了但没被调用"**：在 `XesWebView` 里搜 handler 名。

- 搜得到注册、用户端无反应 → 问题在参数解析或 H5 侧调用时机，不在能力缺失。
- 搜不到 → 该能力在当前版本确实没有，H5 在调用一个不存在的接口。**H5 侧通常不会报错，只会静默无响应**，这是这类问题看起来"毫无线索"的原因。

**区分容器侧还是 H5 侧**：同一个能力在别的 H5 页面能用，只在云学习页面不能用 → 优先看 H5 侧；
所有页面都不能用 → 优先看原生注册与参数。

## 注意

- **H5 调不存在的 handler 不会抛错，只会没反应**。排查时不要因为"没有报错"就排除契约问题。
- **回调结构（字段名）和 handler 名一样是契约**。参数或回传字段改了而只改了一边，表现同样是
  静默失败，不会崩。
- 用户信息、设备信息是 H5 启动时批量拉取的，**其中任何一项取不到都可能导致 H5 静默降级**，
  而不是弹错。
- xesapp 侧容器与通用能力的边界、**接口契约**与验证入口以该仓库自己的
  `harness_Engineering/knowledge/`（`code-map.json`、`contracts/`）为唯一权威源，此处不复述。
