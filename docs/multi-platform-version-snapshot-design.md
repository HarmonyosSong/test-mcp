# 多端版本 → 代码快照解析技术方案

状态：草案 v1（2026-11-12），待评审
上游规划：`multi-capability-expansion-plan.md` §2.4（按确认平台和精确版本选择源码，选择器已实现）、§3.1（多端产品化）

## 1. 背景与目标

诊断链路当前只服务 HarmonyOS，会话绑定单一仓库快照。多端接入后，老师报上来的问题发生在 Android/iOS 上，诊断必须读取**与学员设备上安装的精确版本同一份发布代码**，否则日志行号、符号、逻辑分支全部对不上。

本文档覆盖的范围：

1. 各端真实仓库的确认与登记（壳仓、组件仓、配置仓）。
2. 用户口述版本号 → 唯一 commit → 可物化代码快照的解析链路。
3. 多仓快照的获取、缓存、布局与会话挂载。
4. 凭据、权限与安全边界。

不覆盖：端上下文注入、Skill/知识排序差异（见规划 §3.1）、代码索引三端验收（见规划 §3.4）、自动平台识别（规划明确"未完成平台和版本证据链前，不开放根据老师描述自动选端"）。

## 2. 已确认事实（2026-11-12 实测，非推测）

以下全部通过 GitLab REST API 实测获得，凭据为 `.env` 中 `ANALYSIS_GIT_USERNAME` / `ANALYSIS_GIT_TOKEN`（账号 `jiminghui`，对 `peiyou_online_app`、`peiyou_xueersiapp_XesApp` 组均为 Owner/50 级）。

### 2.1 仓库清单

| 端 | 产品线 | 仓库 | 角色 | 备注 |
|---|---|---|---|---|
| HarmonyOS | 全部四线 | `peiyou_xueersi_harmony/xesapp` | 壳仓 | **一仓四包**：学而思/学而思HD/学家云/学家云HD 四个 C端包同仓构建，按 bundleName 变体区分（已确认，§8-4） |
| Android | 学而思 | `peiyou_xueersiapp_XesApp/xesApp_Android` | 壳仓 | |
| Android | 学家云 | `peiyou_xueersiapp_XesApp/xuejiayunapp_android` | 壳仓 | |
| Android | 学而思 HD | `peiyou_xueersiapp_XesApp/xesApp_Pad_Android` | 壳仓 | 未实测 |
| Android | 学家云 HD | `peiyou_xueersiapp_XesApp/xuejiayunapp_pad_android` | 壳仓 | 未实测 |
| Android | 共用 | `peiyou_xueersiapp_XesApp/XesApp_Business_Modules` | 组件仓 | Androidx 业务组件 |
| Android | 共用 | `peiyou_xueersiapp_XesApp/android-config-files` | 配置仓 | 未实测 |
| iOS | 学而思 | `peiyou_xueersiapp_XesApp/xesApp_iOS` | 壳仓 | |
| iOS | 学家云 / 学家云HD | `peiyou_xueersiapp_cloudlearning_iOS/CloudLearning_Main_iOS` | 壳仓 | README 自述"学而思云学习新版主工程"；含 `com.xes.ips`、`com.xes.ipsapp` 两个 app target；发布 tag 统一 `XesAppHD` 前缀（已确认，§8-1） |
| iOS | 共用 | `peiyou_xueersiapp_XesAppModuleiOS/XesApp*Code`（数十个） | 组件仓 | XesAppMainCode、XesAppNetworkingCode 等 |
| iOS | 共用 | `peiyou_xueersiapp_XesAppModuleiOS/XesAppRepo` | 私有 spec 仓 | Podfile 中作为 `:source` 引用 |
| iOS | 共用 | `peiyou_xueersiapp_XesApp/specRepo_iOS` | 私有 spec 仓 | 描述为"学而思APP-iOS组件私有spec仓库" |

### 2.2 Tag 命名约定（各取最新 10 条实测）

| 仓库 | 样例 | 解析模式 |
|---|---|---|
| `xesapp`（鸿蒙壳） | `7.106.0`、`5.106.0` | **纯 marketing version 即 tag**，三端中最简；7.x=学而思系、5.x=学家云系，与 iOS 各产品线版本系列一致；同仓两系列并存，产品线由版本号系列区分 |
| `xesApp_iOS` | `XesApp_v7.106.0_1_20261105` | `{App}_v{MARKETING_VERSION}_{CURRENT_PROJECT_VERSION}_{yyyyMMdd}`；pbxproj 实测 `MARKETING_VERSION = 7.106.0`、`CURRENT_PROJECT_VERSION = 1`，与 tag 中段完全吻合 |
| `CloudLearning_Main_iOS` | `XesAppHD_v5.106.0_1_20261105` | 同上模式，前缀 `XesAppHD`，主版本 5.x 独立系列 |
| `xesApp_Android` | `V7.106.5-55373-TEST`、`V7.106.5-55364-CUSTOM` | `V{versionName}-{构建号}-{后缀}`；近 100 条后缀分布 TEST 79 / CUSTOM 20 / GOD 1，无 RELEASE 形态（已确认，§8-2）；后缀是构建类型标记，不进版本键 |
| `xuejiayunapp_android` | `V7.106.5-1074-CUSTOM` | 同上模式，构建号独立系列 |

### 2.3 版本号文件与组件锁定

**HarmonyOS（`xesapp`）**：

- `AppScope/app.json5`：`versionName` / `versionCode`（鸿蒙惯例位置）。HEAD 上仍是 `7.76.0`，与 Android 同样存在主干滞后——快照必须按 tag/commit 取。
- bundleName 变体：`com.xes.harmonyapp` 学而思、`com.xes.harmonyHD` 学而思HD、`com.xes.xuejia.harmonyapp` 学家云、`com.xes.xuejia.harmonyHD` 学家云HD（`app.json5` 注释内实测；注释里另有 STEAM/科学两条历史遗留，对应包不存在，登记不考虑）。打包时按目标包改写 app.json5。
- 组件形态为仓内 HAR 模块（`XesCourseCenter`、`XesOrder` 等 build-profile 模块列表），**源码随壳仓快照天然完整**——鸿蒙没有跨仓组件回溯问题，这是与 Android/iOS 的最大差异。

**Android（`xesApp_Android`）**：

- `gradle.properties`：`APP_VERSION=7.104.5`、`APP_CODE=1080405`、`APP_ONLINE_VERSION=7.104.5.1-attainment-phone`，以及组件版本钉 `BCMPT_VERSION=7.104.5.1-SNAPSHOT`、`HOME_VERSION=...` 等一组 `*_VERSION`。**版本号与组件版本锁在同一个文件**。
- `config.gradle`：`versionName: "${APP_VERSION}"`、`versionCode: "${APP_CODE}"`，构建期注入。
- `component.properties`：`IS_REMOTE=true` + 每个组件 `true/false`，控制组件走远程 Maven 还是本地源码（来源开关，非版本锁）。
- 注意：主干 HEAD 的 `APP_VERSION=7.104.5` 落后于最新 tag `7.106.5`，发版 bump 发生在分支/tag 上——**版本 → 快照必须按 tag/commit 取，禁止用 HEAD 近似**。

**iOS（`xesApp_iOS`）**：

- `XesApp/XesApp.xcodeproj/project.pbxproj`：`MARKETING_VERSION`（当前 HEAD 为 7.106.0，与最新 tag 吻合，iOS 主干跟随发版）。
- `XesApp/Podfile`（402 行，**组件版本锁本体**）：四组开关 `Online_Pod / Subject_Pod / XesApp_Pod / XesAppBase_Pod`（0=本地源码 `:path => "../../XesAppModules/..."` 兄弟目录，开发态；1=远程 Framework）。远程模式下**组件版本直接硬编码在 Podfile 里**：`pod_framework 'XesAppKit','2.6.34'`（`:source => XesAppRepo.git`）。已实测组件仓 `XesAppModuleiOS/XesAppKitCode` 存在同名 tag `2.6.34`——**app tag → Podfile 版本钉 → 组件仓同名 tag → 组件源码**，回溯链完整闭环（已确认，§8-3）。
- 根目录与 `XesApp/` 下均未观察到 `Podfile.lock` 入库；锁定不依赖 lock 文件，Podfile 版本钉即锁。
- 组件 Framework 的发布工具：`XesAppModuleiOS/XesAppModuleTool`（Jenkins，`package-fw` 子命令，按 `--BuildBranch` + `--TagVersion` 发布到私有 spec 仓）。

### 2.4 凭据通路现状

- API 通路（`PRIVATE-TOKEN` 头）完全可用：项目/组/标签/文件/归档接口均 200。
- git 协议通路（`git clone/ls-remote`）被拒：token 未勾 `read_repository` scope。
- 结论：**本方案全部环节用 API 即可落地，不阻塞**；服务化阶段再补 `read_repository`（§7.4）。

## 3. 总体架构

三层，自下而上：

```
┌─────────────────────────────────────────────────────┐
│ 会话挂载层  会话端上下文 → 仓库集合 → 多快照挂载      │
│            证据账本观测携带 repo+commit+path          │
├─────────────────────────────────────────────────────┤
│ 快照获取层  GitLab API archive → 本地缓存 → commit 校验│
│            manifest 记录来源，缺失即 snapshot_not_ready│
├─────────────────────────────────────────────────────┤
│ 版本登记层  tag 扫描 → 版本登记表（一行一版）          │
│            解析器：规范化 → 精确唯一命中 → 拒绝回退     │
└─────────────────────────────────────────────────────┘
```

与规划 §2.4 的关系：§2.4 已在仓库记录上定了 `platform` + `version_map`（`branch` + `expected_commit`）契约和硬约束（精确唯一命中、禁止默认分支回退、`snapshot_not_ready`、旧会话不改绑）。本方案是它的**实例化与多仓扩展**：登记表 schema 在 `{branch, expected_commit}` 上 additive 扩展为多仓形态，解析/获取/挂载三层全部遵守 §2.4 已定硬约束，不重开已收敛的决策。

## 4. 详细设计

### 4.1 端与产品线模型

`platform` 沿用 §2.4 的三值枚举（`harmony | android | ios`）。产品线不是新维度，而是**端上下文里的排序与仓库存根**：

```ts
type ProductLine = 'xueersi' | 'xuejiayun';           // 学而思 / 学家云
type RepoRole = 'shell' | 'component' | 'config';

interface PlatformRepo {
  repository_id: string;        // GitLab path_with_namespace，全局唯一
  platform: 'harmony' | 'android' | 'ios';
  product_lines: ProductLine[]; // 一个仓可服务多条产品线（组件仓）
  role: RepoRole;
}
```

HD 不作独立 platform：它是 `platform + 形态` 的组合（`xesApp_Pad_Android` 是 android 平台的另一个壳仓）。会话端上下文 = `platform + product_line + 形态(phone|pad)`，映射到唯一壳仓 + 共享组件仓集合。

**HarmonyOS 是这个模型的一个特化**（§2.1/§2.3 实测）：四 C端产品线共用一个壳仓，产品线不映射到独立仓，而是映射到**仓内 bundle 变体**（四个 bundleName，§2.3）。对版本解析而言鸿蒙最简单——`platform=harmony` 时壳仓恒为 `peiyou_xueersi_harmony/xesapp`，产品线只影响 tag 系列选择（学而思系 7.x / 学家云系 5.x）、包身份标注和知识排序；且组件为仓内 HAR 模块，快照天然完整，M4 的跨仓组件回溯对鸿蒙不适用。登记表中鸿蒙每行登记的 `repos` 永远只有这一个壳仓，但 `product_lines` 标全四线。

### 4.2 版本登记表

**一行一版**，初始数据由 tag 扫描半自动生成，人工核对后生效：

```yaml
# version-registry/<platform>/<product>.yaml
- version: 7.106.5            # 规范化后的 marketing version
  builds:
    - build: "55364"          # Android 构建号 / iOS 留空时用 CURRENT_PROJECT_VERSION
      tag: V7.106.5-55364-CUSTOM
      repos:
        - repository_id: peiyou_xueersiapp_XesApp/xesApp_Android
          role: shell
          ref: V7.106.5-55364-CUSTOM
          expected_commit: <40位sha>     # 扫描时解析 tag→commit 固化
      source: tag-scan        # tag-scan | manual
      verified: false         # 人工核对后置 true，未核对不参与诊断绑定
```

关键规则：

1. **登记表是唯一权威映射**，模型和工具都不得自行猜测 tag 规律；tag 扫描脚本只是生成登记候选的离线工具，不进运行时链路。
2. 扫描时即把 tag 解析成 commit 固化进 `expected_commit`（GitLab tag 可移动，登记不可变）。
3. `verified=false` 的版本仅用于调试，诊断绑定只接受 `verified=true`。
4. 登记粒度到 build：同一 marketing version 的多个 build 各占一行，命中哪个取决于日志/用户提供的构建号；只有 marketing version 且该版本只有一个 `verified` build 时才允许选择，多个已核验 build 必须追问构建号，禁止猜测。
5. Android 的 `-TEST/-CUSTOM` 后缀、iOS 的日期段不进版本键，只作为 tag 定位信息。

### 4.3 解析算法与失败语义

输入：`platform + 版本串`（来自老师确认或日志设备字段），输出：唯一登记行或明确失败。

1. **规范化**：去 `v/V` 前缀、去空白；`7.106.5.1` 归一到 `7.106.5`（第四段为热修/渠道号，登记在 build 维度）；无法解析为 `x.y.z` 直接失败。
2. **精确命中**：登记表内 `version` 相等且 `verified=true`；命中 0 行 → `version_not_registered`；命中多行且无法用 build 消歧 → `version_ambiguous`（返回候选 build 列表，请老师补充构建号）。四段热修版本没有 build 时直接返回 `build_required`。
3. **禁止回退**：任何失败都不允许退回"最新版本""默认分支""会话原仓库"（沿用 §2.4 硬约束，此处只是复述其在本层的落点）。
4. **热修分支**：首版不参与自动消歧（§2.4 已定）；热修版本（第四段）必须同时有 build/渠道信息才允许登记。

### 4.4 快照获取与缓存

**当前通路（API archive）**：

```
GET /api/v4/projects/<id>/repository/archive.tar.gz?sha=<expected_commit>
  → 落盘 .data/snapshots/<repository_id 哈希>/<expected_commit>/
  → 写 .harmony-agent-snapshot.json：{repository_id, requested_ref, resolved_commit, workspace_path, source: 'gitlab-api-archive', created_at}
```

约束：

- 获取前先用 `GET /repository/commits/<sha>` 确认 commit 存在且与登记一致；`expected_commit` 不符一律 `snapshot_not_ready`，不半绑定（§2.4）。
- 缓存键 = `repository_id + expected_commit`，内容寻址，天然幂等；同一版本跨会话共享。
- 归档是整包（无 git 历史的源码树），Android 壳仓数百 MB 级，首次获取慢、可异步物化；磁盘水位由独立清理策略按 LRU 控制。
- API 有频率限制：物化器串行 + 本地锁，同一快照并发请求合并为一次。

**服务化通路（将来）**：token 补 `read_repository` 或换服务账号后，改浅克隆（`--depth 1 --branch <tag>`）+ 增量 fetch，接口抽象不变，只换物化器实现。

### 4.5 多仓快照与相对布局

一个版本 = 壳仓 + 按需追加的组件仓。挂载时**必须还原构建时的相对布局**，否则代码导航的跨仓跳转和构建配置引用全部错位。

**iOS（回溯链已闭环，§2.3）**：诊断回溯走**发布态链路**——app tag 上的 Podfile 版本钉 → 组件仓同名 tag → 组件快照，与构建时实际打进包的 Framework 版本严格一致。Podfile 里 `:path => "../../XesAppModules/..."` 的兄弟目录布局仅是**开发态**（开关=0）形态，诊断不需要还原；只有需要模拟"本地源码构建"场景时才挂载兄弟布局，此时需要一张**组件仓 → 检出目录名**映射（`XesAppMainCode` 仓 → `XesAppModules/XesAppMain/XesAppMainCode`），可从 Podfile 自动提取。

**Android**：`component.properties` 的 `IS_REMOTE=true` 意味着发布构建用 Maven 二进制组件——**组件源码不在壳仓快照里**。回溯组件源码需按 `gradle.properties` 的 `*_VERSION`（主干上是 `x.y.z.1-SNAPSHOT`，发版 tag 上应为定格版本）映射到组件仓对应 tag。组件仓 tag 命名约定未实测，列为 M4 的前置侦察（与 iOS 不同，Android 的组件版本钉在 gradle.properties 而非 Podfile，但同样"壳仓 tag → 版本文件 → 组件仓 tag"的三段链结构成立）。

**分阶段原则**：M1–M3 只做壳仓快照（覆盖绝大多数崩溃/日志行号定位）；M4 才做组件源码回溯。一个版本只物化了壳仓时，会话必须声明"组件源码未挂载"，不能冒充完整组件闭环（§2.4 硬约束的复述）。

### 4.6 会话挂载与证据账本

- 会话端上下文确认平台/版本后，按 §4.3 解析出登记行，物化其 `repos` 列表，全部 commit 校验通过才允许换绑。
- 换绑方式遵守 §2.4 未决策项："新会话还是显式 Runtime 换绑"在实现前单独固定状态与证据隔离契约；本方案不预选，但登记表/快照层对两种换绑方式中立。
- 旧会话与旧证据保持原 commit，不 retroactively 改绑（§2.4）。
- 证据账本 additive 扩展：每条源码/日志观测增加 `repository_id + commit + path`；现有多仓审计字段在 ledger 内补齐，不新开平行结构。
- 工具层（`read_project_file`、`search_project_text`、Repository MCP）接收显式的快照根句柄，禁止模型直接构造路径。

### 4.7 运行时配置

```yaml
# runtime 配置（示意）
gitlab:
  base_url: https://git.100tal.com
  username_env: ANALYSIS_GIT_USERNAME
  token_env: ANALYSIS_GIT_TOKEN
snapshot_store:
  root: .data/snapshots
  max_gb: 50
version_registry:
  root: version-registry/
```

凭据纪律（沿用既有约束）：token 从 `.env` 读入内存，不打印、不写入日志/证据/SSE/持久化、不出现在错误消息里；登记表和快照 manifest 只记录仓库路径、tag、commit。

## 5. 安全与隐私

- 全部通路只读；任何写操作（push、tag、issue）即使 token 有权也禁止调用。
- 快照落盘目录纳入既有授权根目录管理；学员数据不进入快照层。
- 真实学员联调需单独授权（规划 §2.5 已定），本方案的验收全部用合成 fixture。
- token 泄露面：仅 `.env` 与运行时内存；轮换时只改 `.env`。
- 外部协查（Compass）外发文本不含本层任何凭据与内部仓库 URL 之外的敏感信息——仓库路径属内网信息，按现行内网不伪名化决定处理。

## 6. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 版本登记 | tag 扫描脚本（离线）+ 4 个壳仓登记表 + 解析器 + 规范化/歧义/未登记测试 | 登记版本可绑定 commit；未登记版本不静默回退（对齐规划步骤⑤） |
| M2 快照物化 | API archive 物化器 + 内容寻址缓存 + commit 校验 + manifest | 断网重放命中缓存；commit 不符返回 `snapshot_not_ready` |
| M3 会话挂载 | 端上下文 → 壳仓快照换绑 + 证据账本 repo/commit/path 扩展 | 合成 fixture：报 Android 7.106.5 问题，证据全部来自该 commit 快照 |
| M4 组件回溯 | iOS：解析 Podfile 版本钉 → 组件仓同名 tag 挂载；Android：`*_VERSION` → 组件仓 tag 侦察与接入；Podfile `:path` 开发态布局（仅模拟本地构建时需要） | 跨仓跳转测试；组件未挂载时会话显式声明 |
| M5 端到端 | 三端合成问题集回归 | 对齐规划 §2.5 第 6 条与步骤⑤全部验收项 |

M1–M4 均不依赖外部确认，可立即开始。

## 7. 凭据与权限演进

1. **现在**：`jiminghui` 个人 token（read_api）→ 覆盖 M1–M4 全部需求。
2. **服务化前**：找组管理员把 Runtime 服务账号加为 Reporter（最小权限），token 勾 `read_api + read_repository`；个人 token 吊销。
3. 组件仓（`XesAppModuleiOS` 组等）对服务账号逐个确认 Reporter 权限，登记表生成时自动探测权限缺口并报缺。

## 8. 开放问题

**已自行查证闭环（2026-11-12）**：

1. ~~`CloudLearning_Main_iOS` 产品线归属~~：已确认是**学家云 iOS 主工程**——README 自述"学而思云学习新版主工程"，含 `com.xes.ips`、`com.xes.ipsapp` 两个 app target（对应学家云两个形态，精确映射关系登记首次核对时确认即可），`TARGETED_DEVICE_FAMILY` 同时含 `1,2`（universal）与 `2`（iPad-only），近 100 条发布 tag 全部 `XesAppHD` 前缀、5.x 版本系列。
2. ~~Android 发版 tag 后缀~~：近 100 条分布 TEST 79 / CUSTOM 20 / GOD 1，**无 RELEASE 形态**；对比 CUSTOM 与 TEST tag 上的 `gradle.properties` 内容一致（版本字段相同），后缀是构建类型标记而非版本区分。登记以 `APP_VERSION + APP_CODE` 为版本键、tag 全名照录（§4.2 第 5 条规则据此实证）。残余项：线上正式包具体对应哪类后缀的 tag 属打包平台数据，仓库内不可考，不阻塞登记（先取最新 CUSTOM/GOD）。
3. ~~iOS 组件版本锁定机制~~：**Podfile 即锁**。四组开关区分本地源码（开发）与远程 Framework（发布）；发布态组件版本硬编码为 `pod_framework 'XesAppKit','2.6.34'` 形式，从私有 spec 仓 `XesAppRepo` 解析；已实测组件仓 `XesAppKitCode` 存在同名 tag `2.6.34`，**app tag → Podfile 版本钉 → 组件仓 tag** 回溯链闭环。无 `Podfile.lock` 入库不影响。

**已确认纳入（2026-11-12）**：

4. ~~鸿蒙侧是否纳入同一登记表~~：**纳入**。实测 `peiyou_xueersi_harmony/xesapp` 一仓构建四 C端包（bundleName 变体，§2.3），tag 为纯版本号、学而思系 7.x 与学家云系 5.x 同仓两系列；登记表中鸿蒙每行 `repos` 恒为这一个壳仓，`product_lines` 标全四线（§4.1 特化）。

**仍待确认（不阻塞 M1–M3）**：
5. **Pad 壳仓（`xesApp_Pad_Android`、`xuejiayunapp_pad_android`）** 未实测，tag 约定假设与手机一致，登记扫描时验证。
6. **Android 组件仓 tag 命名**：`*_VERSION` 值（如 `7.104.5.1`）与组件仓 tag 的对应形态未实测，M4 前置侦察（iOS 已验证"同名 tag"模式，Android 待同样验证）。
