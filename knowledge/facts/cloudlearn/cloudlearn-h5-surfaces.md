---
name: cloudlearn-h5-surfaces
domains: [cloudlearn]
kind: mapping
description: 云学习 H5 寄生在 xesapp 容器里的具体页面、各自加载的前端站点，以及三套环境的域名差异
applies_to: [harmony]
authority: code
updated_at: 2026-09-17
verified_at: 2026-09-17
aliases:
  - 云学习页面
  - 云学习入口
  - 云学习 H5
  - 云学习有哪些页面
  - 口语岛页面
  - 云听课
  - 成长首页
  - 云学习在哪
  - 测试环境正常正式环境失败
  - 测试环境好线上不行
  - 换了环境就不行
  - cloudlearn
---

# 云学习 H5 在 xesapp 里的挂载面

`xesapp`（学而思鸿蒙主壳）本身是一个**容器**：它内部有一批原生页面，页面里用 `XesWebview`
加载云学习的前端站点。用户看到的"云学习功能"，实现代码大部分不在 xesapp 里。

这个事实决定了一件事：**同一个用户问题，责任方可能在容器侧，也可能在 H5 侧，而两边的代码
不在同一个仓库**。排查时必须先确定自己站在哪一边。

## 挂载点

| 现象里的说法 | 原生页面（xesapp 内路径） | 加载的站点 | 路由入口 |
| --- | --- | --- | --- |
| 绘本朗读 / 语音评测 / 口语岛 / 磨耳朵 | `XesClassLearn/src/main/ets/page/ClassLearnSpokenIsLandH5Page.ets` | `english-oralisland-fe` | `talxesapp://classLearn/ClassLearnSpokenIsLandH5Page` |
| 云听课 / 语文课直播 | `XesClassLearn/src/main/ets/page/ClassLearnYunTingKePage.ets` | **有视频时** `chinese-library-fe`（播放页，套 `yuntingke` 的流）；<br>**拿不到视频时 fallback 到 `xesConfig.taskAnswerUrl`**——<br>⚠️ 该页是**内嵌 H5 容器、按有无视频分流**，不是固定一个站点 | `talxesapp://classLearn/ClassLearnYunTingKePage` |
| 视频任务 / 视频答题 / 投屏 | `XesClassLearn/src/main/ets/page/ClassLearnVideoAnswerPage.ets` | `instruction/guide/harmonyos`、`xjyBaseUrl` | `talxesapp://classLearn/ClassLearnVideoAnswerPage` |
| 英语图书馆 / 绘本列表 | `XesClassLearn/src/main/ets/page/ClassLearnEngLibraryH5Page.ets` | `english-library-fe` | `talxesapp://classLearn/ClassLearnEngLibraryH5Page` |
| 成长首页 | `products/*/src/main/ets/entryability/EntryAbility.ets`（预热） | `grow/home` | 首页内嵌 |

其余云学习站点在 xesapp 里**没有独立原生页面**，由上述页面透传 `h5Url` 进入，或经
JSBridge 的 `xesApp_nativeAbility_openNativeView` 跳转：

`taskanswer-fe`（任务答题）、`learn-word-fe`（识字阅读 / 学词）、`recite-word`（背单词）、
`points-card-fe`（积分卡）。

站点地址不是常量，而是按环境切换的配置项，集中在
`XesBusiness/XesBusinessComm/src/main/ets/utils/XesConfig.ets`。

## 判据

**确认用户在用云学习功能**（而不是 xesapp 自己的课程 / 订单业务）：

- 代码：配置里的 `XesConfigManager.isCloudLearn()` 为真，或页面属于 `XesClassLearn` 模块。
- 话术：用户描述的学习行为是朗读评测、背单词、识字、磨耳朵、云听课一类，而不是买课、订单、上课提醒。

**确认请求打到哪个站点**：看 WebView 的实际 URL 主机名。三套环境的同一个站点前缀不同：

| 环境（`XesAppNetworkEnvironment`） | 站点前缀 |
| --- | --- |
| 开发 / 内测（fz） | `cloudlearn-h5-fz.speiyou.com` |
| 灰度（nc / GRAY） | `cloudlearn-h5-nc.speiyou.com` |
| 正式（RELEASE） | `cloudlearn-h5.speiyou.com` |

接口基址同理：`cloudLearnBaseUrl` 分别是 `cloudlearn-fz` / `cloudlearn-nc` / `cloudlearn`。

## 注意

- **"同一功能在测试环境好、正式环境坏"要先排除环境配置差异**，上表就是差异所在，不要先去查业务逻辑。
- xesapp 与云学习 H5 是**两个仓库、两个发布节奏**。xesapp 发版不能保证 H5 不回滚，H5 发版也不
  能保证容器侧同步，时间点比对是排查"昨天还好"类问题的必要动作。
- 本条目只写"谁挂在谁的哪里"。容器侧的模块边界、**接口契约**与代码导航以 xesapp 仓库自己的
  `harness_Engineering/knowledge/code-map.json` 为唯一权威源，**不复述**。
- 证据取自 xesapp 只读代码快照，随仓库演进会过期；重新核对时以上面列出的文件为准。
