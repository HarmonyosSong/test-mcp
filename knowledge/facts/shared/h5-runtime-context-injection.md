---
name: h5-runtime-context-injection
domains: [shared]
kind: mapping
description: H5 不知道自己在哪个容器里，全靠原生注入的 UA、cookie 和 URL 开关判断；注入不同则同一页面走不同分支
applies_to: [harmony]
authority: code
updated_at: 2026-09-17
verified_at: 2026-09-17
aliases:
  - app 内嵌还是浏览器
  - 浏览器里正常 app 里不行
  - 微信里正常
  - 同一个页面表现不一样
  - UA 不一样
  - cookie 没带上
  - 环境注入
---

# H5 靠原生注入判断自己在哪

云学习 H5 是同一套前端代码，**在 App 内嵌、独立浏览器、微信里都会跑**。它区分自己身在何处，靠的
不是自己的能力，而是**宿主注入给它的环境**：

| 注入物 | 由谁给 | H5 用它判断什么 |
| --- | --- | --- |
| 自定义 UA | 容器（`XesWebview.getUA` → `setCustomUserAgent`） | 是不是 App、哪个 App、手机还是平板、版本、语言、城市 |
| `tal_token` cookie | 容器（`configCookieSync` 写 `passport.100tal.com`） | 登录态。浏览器里没有，需要另走登录 |
| URL 上的 `isNative=true` | 打开这个页面的调用方 | 走原生能力分支还是网页分支 |
| `extendInfo` | 打开方传入（`client_id`、`Portrait`、安全区高度） | 布局与业务参数 |
| `xesApp_nativeAbility_getNativeInfo` | 容器应答 H5 的主动询问 | 用户、设备、环境信息（在线学习环境模式等） |

**UA 是拼出来的，不是系统原生的**：`XesApp/<版本> lang=… dv=… version=… cityCode=… clientType=…`，
平板与 PC 用 `XESIPS/` 前缀（PC 端还会把 UA 里的 `PC` 替换成 `tablet` 伪装成 pad）。
**所以"H5 以为自己在什么设备上"由容器说了算，不是你手上那台设备说了算。**

## 为什么这条决定了排查的第一步

用户说"这个功能在 App 里不行"，先要问的是**这个功能是不是只有 App 里才有**：

- **只有 App 内嵌才有**（依赖 JSBridge / 原生能力 / 注入的 cookie）→ 问题可能在容器侧，
  H5 侧看不到根因，他们的知识库也不覆盖这一段。
- **H5 自己也能独立跑**（浏览器里同样入口）→ **先让用户在浏览器里试一次**。
  - 浏览器里也不正常 → 大概率在 H5 或后端，与容器无关，可直接交给云学习侧。
  - 浏览器里正常、App 里不正常 → 大概率在注入或容器，重点查 UA、cookie、`isNative`、时序。

**同一个功能可能存在两条进入路径**（App 内嵌一份、H5 独立一份），不是二选一。用户看到的现象
一样，责任方却不同——这是云学习类问题最容易吵起来的地方。

## 判据

1. **看实际 URL 有没有 `isNative=true`**。没有 → H5 走网页分支，不调原生能力。
2. **看 UA**。有没有 `XesApp/` 或 `XESIPS/` 前缀，决定 H5 是否启用 App 专属逻辑。
3. **看 cookie**。`tal_token` 没注入 → H5 认为未登录，行为可能是"能打开但什么都做不了"。
4. **浏览器对照**。同一入口在浏览器里能否复现，是最省事的分诊手段，且用户自己能做。

## 注意

- **注入有时序**：cookie 与 UA 必须在页面加载前设好（代码里挂在 `webInited` /
  `onControllerAttached` 上）。设晚了，H5 已经按"没有登录态"渲染完，表现为**首次进入异常、
  重进正常**——这类"重试就好"的问题要先怀疑时序，而不是网络。
- **浏览器对照只适用于 H5 独立可跑的功能**。依赖原生能力的功能，浏览器里必然不正常，
  用这个方法会得出错误结论。
- **H5 侧的知识库不覆盖容器**：那份知识库的素材契约只接受前端与后端两种角色，客户端在其中
  没有位置。所以"注入对不对"这类问题，只能由这一层来回答，不要指望从那里查。
- 具体注入字段的实现会随版本变，核对时以 `XesWebView` 的 `getUA`、`setCustomUserAgent`、
  `configCookieSync` 调用点为准。
