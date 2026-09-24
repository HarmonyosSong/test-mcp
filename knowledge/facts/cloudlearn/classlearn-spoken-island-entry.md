---
name: classlearn-spoken-island-entry
domains: [cloudlearn]
kind: mapping
description: 语音评测页只有一个原生入口，fromTask 参数把它分派成四条互不相干的链路
applies_to: [harmony]
authority: code
updated_at: 2026-09-17
verified_at: 2026-09-17
aliases:
  - 语音评测入口
  - 口语岛入口
  - 语音评测失败
  - 朗读没有分数
  - 我的作品
  - 磨耳朵
  - fromTask 参数
  - isNative 参数
---

# 语音评测：单入口，四链路

`talxesapp://classLearn/ClassLearnSpokenIsLandH5Page` 是口语岛 / 语音评测在鸿蒙上的**唯一原生入口**。
但它不是"一个页面"，入口参数 `fromTask` 把它分派成四条链路，**加载的 H5 路由、横竖屏、生命周期
处理都不同**。

源码：`XesClassLearn/src/main/ets/page/ClassLearnSpokenIsLandH5Page.ets`，`aboutToAppear()` 里的
`if / else if` 链就是全部分派逻辑。

## 分派规则

按代码里的判断顺序：

| `fromTask` | 语义 | 加载的 H5 路由 | 附带行为 |
| --- | --- | --- | --- |
| `302` | 口语岛 2.0 | 调用方通过 `h5Url` 参数直接传入 | 强制横屏、隐藏系统栏；退出时恢复竖屏（平板除外） |
| `64` | 磨耳朵 | 调用方通过 `h5Url` 参数直接传入 | 页面隐藏时开长时任务保后台播放，销毁时释放播放器 |
| `true`（忽略大小写） | 学习任务 | `evaluationCheckView`（`taskStatus == 6`，我的作品）或 `evaluationView`（其余，语音测评） | 从 `jsonString` 拆 `contentDetailId` 取 `audioId`、从 `contentDetailName` 取标题 |
| 以上都不是 **且带 `resourceId`** | 语音测评 / 资源朗读 | `speaklist?channelId=<resourceId>&title=<resourceName>` | 参数**不是原样透传**：`resourceId` 拼到 **`channelId`**、`resourceName` 拼到 **`title`**（容易看漏） |

**兜底**（最后一个 `else` 里的 `if (resourceId)` **没通过**时）：URL 保持初始值
`<englishSpokenIsLandUrl>/index.html#/?isNative=true`，即**站点首页**。

> ⚠️ 注意**第 4 行和兜底是同一个 `else` 里的两层**——不是两套并列条件：
> 进了 `else` 之后再看有没有 `resourceId`，**有**才拼 `speaklist`、**没有**就停在首页。
> 所以"进去了但没内容（停在首页）"最常见的原因就是**没带 `resourceId`**。

## 判据

**用户说"语音评测失败"时，第一个要问的是他从哪进来的**，这比问机型、网络都靠前：

1. 从"我的作品 / 我的作品列表"进 → `taskStatus == 6` → `evaluationCheckView`。这是**回看**，
   不产生新评测，失败含义与评测本身无关。
2. 从任务 / 作业列表进 → `evaluationView`，`audioId` 由 `jsonString` 解析而来。
3. 从课程内容里的朗读资源进 → `speaklist`，靠 `resourceId`。
4. 从口语岛独立入口进 → `302`，参数由调用方拼装。
5. 说"磨耳朵放不了" → 是 `64`，属于播放链路，跟评测无关。

**能直接证明链路的证据**：WebView 的实际 URL。它自己带着答案——`evaluationView` /
`evaluationCheckView` / `speaklist` 是哪个，就是哪条链路。

## 注意

- **`audioId` 解析失败是任务链路的独有失败模式**：`contentDetailId` 是逗号分隔串，取最后一个
  非空元素；`contentDetailName` 是 `-` 分隔串，取第 2 段。字符串格式一变，URL 里的 `audioId`
  或 `title` 就会是空，页面仍能打开，但 H5 拿不到内容——**表现为"进去了但没内容/评测不了"，
  而不是报错**。这是从 URL 参数直接能看出来的。
- **`isNative=true` 是 H5 判断"我在 App 里"的开关**。原生拼 URL 时带上它，H5 才走原生能力分支。
  少了它，H5 会按浏览器环境处理，表现为"App 里点朗读没反应，浏览器里正常"。任何绕过这个页面
  自造 URL 的调用方都可能漏掉它。
- 页面本身**不做录音和评测**，它只负责带参数加载 H5。录音、上传、评测结果都由 H5 通过 JSBridge
  调原生完成，契约见 [[classlearn-h5-bridge-contract]]。
- 同一入口承载"新评测"和"看结果"两种相反语义，是这里最容易误判的地方：**先分清再看原因**。
