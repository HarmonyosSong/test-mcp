# Version Registry

按 `platform/<product-line>.yaml` 保存人工核验后的版本到 commit 映射。

运行时只接受 `verified: true` 的记录。首次登记可以使用 `source: tag-scan`，确认线上构建与仓库 tag 对应后再改为核验状态；不要填写未经确认的 commit，也不要把 token 写入登记文件。

示例结构见 `docs/multi-platform-version-snapshot-design.md` §4.2。登记目录由 `HARMONY_AGENT_VERSION_REGISTRY_ROOT` 配置，默认是仓库根目录下的 `version-registry/`。

首条用户提示词明确包含版本时按指定版本绑定；未包含版本时，Runtime 在平台、产品线和形态能够唯一确定的范围内选择最新的 `verified: true` 构建。产品线可以由提示词或已确认的 LogCenter 事实补齐；如果平台/版本仍命中多个产品线或形态，必须补充信息，不跨端或跨产品线猜测。

鸿蒙指定版本未登记时，Runtime 在登记表确定的壳仓查询精确版本 tag（例如 `7.105.0`），使用 GitLab 返回的固定 commit 校验、下载 archive，并在当前部署的数据目录物化快照，不依赖开发机的缓存。不继承其它版本的组件映射。tag 不存在、未配置 `HARMONY_AGENT_GITLAB_TOKEN`（兼容 `ANALYSIS_GIT_TOKEN`）、无权限或下载失败时保留实际缺口，不自动换成更新版本；显式构建号无法由版本 tag 核实时也不猜测。旧会话若已将现场版本替换为较新对照快照，会在下一轮开始时重试精确版本；旧源码证据仍保留原 commit 身份。

安卓指定版本或构建未登记时，Runtime 在登记范围内查询 `V<版本>-<构建号>-TEST/CUSTOM/GOD` tag，严格匹配版本和可选构建号，排除组件 tag、相似版本和附加后缀。产品线、手机/平板已明确时只查询对应范围；缺少形态时依据实际命中的仓库消歧，仍有多个范围则明确指出歧义。未提供构建号时选择同版本最大构建号，并注明尚未确认现场安装包的构建；同一构建的多个类型 tag 若指向不同 commit 则拒绝猜测。无匹配或查询失败时不替换成其它版本，旧会话的跨版本对照绑定也会在下一轮重试。动态发现仅绑定该版本壳仓，不继承其它版本组件，不自动解析 Maven 独立组件源码。

iOS 指定版本或构建未登记时，Runtime 在登记表确定的同产品线、同形态壳仓中查询 GitLab 发布 tag（`XesApp_v<版本>_<构建>_<日期>` 或 `XesAppHD_v<版本>_<构建>_<日期>`，实际前缀沿用登记 tag），精确匹配版本及可选构建，校验 commit 后下载固定快照。动态查询只绑定该版本壳仓，不沿用其它版本的组件 commit，也不改写 YAML。需要配置 `HARMONY_AGENT_GITLAB_TOKEN`。未找到 tag 时可用已登记版本作对照，并明确版本差异；鉴权、网络和下载失败保留实际错误，不解释为版本不存在。

主工程就绪后，iOS 会自动解析同一快照的 CocoaPods 依赖，不需要包名或完整构建号：优先读取 `Podfile.lock` 的版本和 `CHECKOUT OPTIONS` 固定 commit；没有锁文件时提取 `Podfile` 中的字面版本声明。后者可能来自未启用的条件分支，只作为实现对照，不能证明现场打包版本。Runtime 不执行 Podfile Ruby，不从注释、版本范围或可变分支猜测 commit。

组件仓库身份规则在 `runtime/contracts/ios-components.yaml`，目前包含 XesApp 和 CloudLearning 源码仓命名映射；依赖中显式声明的同 GitLab 主机 git 地址也可使用。每个组件通过自身精确 tag/commit 校验后下载、按 commit 缓存并挂载到 `components/<组件名>`。锁文件同时包含传递依赖；仅有 Podfile 时不声称已覆盖传递依赖。没有固定版本、没有映射、下载失败或超过 40 个组件上限时保留具体缺口，其它仓库继续使用。只有所有已列出依赖都可解析且没有对照限制时，才标记完整。

旧的 iOS 主工程单仓会话会在后续轮次补挂载组件，保留原主工程 commit；Web 和知音楼共用准备流程。Web 先发送运行开始事件，再准备源码，下载期间持续发送 SSE 心跳。

参考了 BugGenie `gitWoker` 分支的模块独立同步、部分失败隔离与缓存方式；未接入其依赖 `packageName + buildNumber` 的 `packageGitInfo` 必填路径。
