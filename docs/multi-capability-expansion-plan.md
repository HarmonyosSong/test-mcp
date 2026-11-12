# 后续能力规划

> 当前重点：验收“学员标识 → 设备/会话日志 → 实际平台与版本 → 对应源码 → 联合报告”的真实生产覆盖，并完成观察后的源码换绑。本文区分已完成的框架和未完成工作；现有实现以 [ARCHITECTURE.md](ARCHITECTURE.md)、[orchestration-layer-design.md](orchestration-layer-design.md) 为准。

## 1. 已固定、不再重复讨论的方向

- Runtime 是稳定内核和 Supervisor，不为每个客户端平台复制 Agent。
- HarmonyOS、Android、iOS 共用一个客户端诊断 Agent；端差异由已确认上下文、Skill、知识排序和源码快照承载。
- Compass 是统一外部全栈 Agent 的第一个 A2A Slot，对端覆盖本项目前端、H5 和服务端。客户端不直连对端知识库，也不把 Compass 当作客户端日志查询接口。
- 知识库提供产品规则、候选原因和排查导航，不替代现场日志与源码。
- IT 老师报告的“鸿蒙”只是 `reported_platform`。只有关联到当前学员、设备或会话的实际日志/设备事实才能形成 `observed_platform`。
- grep/搜索只寻找候选实现，结论前必须 read 调用上下文。
- 固定脱敏外发、Runtime 自动协查、预算、取消、远端结论隔离和联合报告规则继续沿用现有实现，不为新链路开旁路。

## 2. 当前优先级：完整客户端排查链

按以下依赖顺序实施，前一步没有可靠事实时不得跳步伪造后一步。

### 2.1 学员标识与私有关联上下文

目标：从老师通常提供的学员编号、联系电话和故障现象中，建立仅供 Runtime 使用的本轮关联上下文。

- 只从当前会话用户原文的明确标签提取标识，不从 assistant 文本、其他会话或模型补全中获取。
- 原始值只在单次调用内存中用于匹配；模型工具 schema 不接收这些私有上下文字段。
- 工具结果、事件和证据只保留匹配事实、脱敏文本及本轮 HMAC 伪名。
- 单轮随机密钥不持久化，不承诺跨轮伪名或日志证据 ID 可重放。
- 学员标识不能自动满足 Compass 的 `correlationReady`；请求级 traceId/requestId 仍是另一维度。

**框架已实现：**`client-identity.ts`、`client-context.ts`、`log-privacy.ts` 已接入每轮能力会话，并有合成测试。后续仍需用真实授权、脱敏 fixture 验证提取和脱敏覆盖。

### 2.2 LogCenter 目标绑定与设备/会话发现

目标：先找到当前学员实际产生的客户端日志，再判断平台和版本。

1. 修正 count/search 查询条件一致性，count 必须传递与 search 相同的 query。
2. `resolve_log_target` 后由 Runtime 绑定 account/collection/topic/appid，禁止模型自行发明或切换坐标。
3. Catalog 以 additive 方式声明已核实的身份、设备、会话、平台和版本字段；未核实的 HarmonyOS 坐标和字段保持空缺。
4. 通过有界 count/search 发现候选设备/会话，解析实际条目；查询失败、权限不足和覆盖缺口分别呈现。
5. 只有条目在脱敏前命中当前学员标识，且平台字段可唯一解释时，才生成 `observed_platform`。store 名、目录命中、普通业务日志、空结果、冲突字段均不能确认。
6. 没有真实“讲义邮寄”或 HarmonyOS 映射时返回 `not_found`/覆盖缺口，不编造 topic、appid 或业务字段。

**框架已实现：**count/search query 一致、用户原文目标绑定、私有身份注入、有界发现、脱敏和 `observed_platform` 冲突处理均有合成 mock 测试。剩余工作是核实生产 Catalog 的身份/设备/会话/平台/版本字段与索引兼容性，并完成另行授权的真实联调；当前没有真实“讲义邮寄”或 HarmonyOS 映射时必须继续失败关闭。

### 2.3 远程日志进入 EvidenceLedger

目标：让满足隐私与关联要求的日志成为可复核观测，而不是仅显示一段辅助文本。

- `EvidenceSchema` additive 增加 Runtime 控制的 `observation_context`，模型草稿不能填写或改写。
- `capture()` 改为注册式观测适配器；每条合格日志生成一条 `kind=log` 证据，保留脱敏摘录、时间窗、目标、匹配事实、脱敏版本和稳定条目身份。
- `resolveDraft()` 恢复账本原文时必须透传观察上下文。
- 日志关联门禁至少验证：目标绑定可信，且条目与当前学员/设备/会话或请求级标识匹配。仅 `kind=log` 不足以放行正向根因。
- 不相关日志引用返回可纠正错误，报告不持久化，不静默修改 verdict。
- 覆盖工具参数、结果、SSE、证据快照、案例归档和 Compass 外发的敏感信息检查。
**框架已实现：**可选 `observation_context`、逐条关联入账、恢复透传、未关联日志拒绝、空结果降级以及工具事件/案例/Compass 学员隐私检查均已接入。当前 `captureRemoteLogs()` 是 LogCenter 专用适配器，尚未抽象成通用注册式插件框架；没有新增观测类型需求时不为此扩大改造。文本流使用有界尾部缓冲处理跨增量标识，并需持续纳入隐私回归。

### 2.4 按确认平台和精确版本选择源码

目标：根据用户提示词与已确认日志事实动态解析端和版本，读取同一份发布代码；会话创建时不绑定仓库，模型也不能选择仓库或分支。

版本登记表是唯一源码选择入口：

```yaml
version-registry/<platform>/<product-line>.yaml
- version: 7.106.5
  form_factor: phone
  builds:
    - build: "55373"
      tag: V7.106.5-55373-TEST
      verified: true
      source: tag-scan
      repos:
        - role: shell
          repository_id: group/app
          ref: V7.106.5-55373-TEST
          expected_commit: "<40-64 hex chars>"
```

硬约束：

- 平台、产品线、形态和版本必须精确、唯一命中；热修分支首版不参与自动消歧。
- 用户提示词明确版本时禁止缺映射后回退默认分支、最新版本或其他会话仓库；提示词未提供版本时，允许在已确认的平台/产品线范围内选择最新已核验登记构建，不能跨端猜测。
- 快照按 `repository_id + expected_commit` 获取并验证 commit；本地缺失、未物化或 commit 不符时明确返回 `snapshot_not_ready`，不能半绑定。
- 已绑定会话和旧证据保持原 commit，不 retroactively 改绑；需要另一版本时新建会话。
- 一个版本对应多个组件仓库时，登记表显式提供 `role + mount_path + expected_commit`；Runtime 先完成全部仓库校验，再生成组合只读快照并原子绑定会话。当前仍不自动解析 iOS Podfile 或 Android `*_VERSION` 生成组件登记，生产登记表需要离线核对后提交。
**选择器和上下文补齐已实现：**平台/产品线/形态/精确版本唯一映射、无版本时最新已核验构建、禁止默认分支回退、GitLab archive 固定 commit 快照、组合工作区、源码证据仓库归属，以及提示词/已保存 LogCenter 事实驱动的绑定已有测试。真实组件版本登记和真实 LogCenter 字段验收仍需单独完成。

### 2.5 完整链验收

以下合成 fixture 验收项已纳入本轮回归；真实生产字段和真实学员仍需另行验收：

1. 无明确标识、普通数字和构建号不会被误当学员 ID。
2. 原始标识不出现在模型可见私有参数、工具事件、证据、持久化结果或默认 Compass 外发中。
3. 老师报告 HarmonyOS、实际日志为 Android 时，得到 `observed_platform=android`，不能继续用 HarmonyOS 仓库解释。
4. 仅 store 命中、目录命中、空结果、查询失败、平台冲突和无身份匹配均不能确认平台。
5. 不相关日志不能进入正向根因证据链；合法日志可跨轮恢复且模型不能伪造上下文。
6. 精确版本映射命中后固定 expected commit；缺映射、缺快照和 commit 不符全部失败关闭。
7. 后续需要外部协查时仍走 Supervisor、固定脱敏摘要、Compass Slot 和联合报告，由 Runtime 自动调用，不绕过现有链路。
8. M4/M5 合成验收：三端会话均能按动态登记绑定固定 commit；组合快照拒绝挂载路径穿越、符号链接和文件冲突；只挂载 shell 的 Android/iOS 会话明确标记源码不完整。

真实学员联调需单独授权；mock 通过不等于生产字段和权限已经验收。

## 3. 后续独立工作

### 3.1 多端产品化

- 会话端上下文、Skill 适用端和知识排序仍需与真实 Android/iOS 仓库完成端到端验收。
- 端只影响排序和适配，不作为知识库硬过滤条件；保留跨域候选与全局回退。
- Runtime 已开放根据用户提示词和已确认日志事实自动选择端与版本；真实生产字段和权限验收完成前，不把合成测试当成生产验收。
- 版本 → 代码快照解析的详细技术方案（真实仓库清单、tag 约定、版本登记表、多仓快照布局与里程碑）见 [多端版本快照解析设计](multi-platform-version-snapshot-design.md)。

### 3.2 Repository MCP 内部代码导航

代码图由 codebase-memory-mcp 作为 Repository MCP 的内部后端提供，Runtime/Agent 不直接连接 CBM。当前只搭建统一只读导航面，未来接入生产前必须：

- 图产物与授权工作区内容指纹严格匹配；轮内变化时拒绝查询，新轮重新校验并构建。
- 模型只能执行 Repository MCP 暴露的有界结构化查询，不能指定图包路径、重建或写回；索引创建由 MCP 内部适配器负责。
- 图节点和边只作候选导航；同名符号、`INFERRED` 边、动态调用和 UI 条件关系必须回读源码。
- 图中没有边不代表没有调用，图命中永不直接进入 EvidenceLedger。
- 首版只挂载 `search_code_symbols`、`get_code_outline`、`trace_code_path`；未配置时不挂载，已配置但命令不可用、失败或超时时显式报错，不得返回空命中伪装成“没有代码”。
- 代码图结果必须经 `read_project_file` 回读才能升级为源码观测；现有 `search_project_text` 的原文观测规则保留。导航工具受 `observe → source` 门禁约束。
- CBM 锁定 0.12.1，仅接受 `fast` 模式，使用独立 `.data/codebase-memory/` 缓存；索引身份绑定授权根目录、源码内容、引擎身份和适配器配置。只索引允许代码的副本，检查副本完整性，避免在原仓库写入索引产物。

### 3.3 多进程与完整多用户数据隔离

当前只支持单进程运行准入。多进程部署前需要 LibSQL lease/CAS、续期、崩溃回收和恢复语义。普通会话 CRUD 的完整主体隔离也应单独审计，不能因历史外发审批已有 owner 校验就宣称所有数据面都完成多租户隔离。

### 3.4 业务知识与三端代码索引（已搭建首版，待验证）

业务知识用于理解规则、术语、对象/动作/状态和区分问题；代码位置、符号及调用关系由绑定源码快照的代码索引维护。知识命中不等于当前故障成立，知识未命中也不阻断日志/源码调查。现行知识 Schema 和定位指引尚未完成此职责迁移，不把目标当成现状。

- 一个客户端 Agent 覆盖 HarmonyOS、iOS、Android；分别验收 ArkTS/ArkUI、Swift/Objective-C/Objective-C++、Java/Kotlin，以及混编和端配置文件。
- 先补齐当前 Repository MCP 的三端文件覆盖和平台/版本约束，再用同一问题集比较现有扫描、ripgrep 与 `codebase-memory-mcp`。后者已有三端相关 grammar 和 MCP，但 ArkTS、Swift/Objective-C 的关系解析精度及 `.mm`/头文件覆盖仍须验证。
- 首版由 Repository MCP 暴露 CBM 导航并保留实时文本搜索兜底；多仓库规模和并发证明需要后，再评估 Zoekt/Sourcebot；语义召回和语言服务按实际缺口引入，不同时堆叠多套引擎。
- 业务知识关系与代码调用图分开治理。保持稳定知识 ID、跨域引用和全局回退；索引按 repository、源码快照、解析器/配置版本校验，图摘要只作导航，源码回读才进入证据链。
- 为索引设置独立持久卷与可重建策略；Docker 重新部署不应触发无条件全量索引。共享索引不替代会话授权和证据隔离。
- HarmonyOS dirty 工作树 PoC 已验证 `codebase-memory-mcp` 0.12.1 的 ArkTS 索引、Struct/Builder 符号和部分调用方候选，源码抽查可对应；排除资源后的 649 个 `.ets` 对照中，中英文自然语言样本仍未命中目标 Top 10。仅继续代码导航实验，暂不接管业务问句；调用边保留静态推断及回调语义缺失的限制。

具体比较、当前缺口、接入边界及验收见 [业务知识与三端代码检索调研](business-knowledge-and-code-search-research.md)。本项不改变现有 `observe → source`、Supervisor 与 A2A 自动协查链路。

## 4. 实施与文档纪律

- 每完成一个垂直切片，同时更新 [ARCHITECTURE.md](ARCHITECTURE.md)、对应 spec 和根 README；不要新增一份重复“现状”文档。
- 历史决策放 ADR，实施任务放 issue/变更说明，不在长期架构文档中累积逐次评审记录和旧测试数字。
- 新字段必须有旧数据兼容测试；新工具必须有禁用、权限、错误、超时、取消和输出上限测试。
- 日志和知识变更分别执行 `make test-runtime`、`make test-mcp`、`make knowledge-validate`，需要时执行 `make live-eval`。
- 不用“工具已挂载”“HTTP 200”替代诊断质量、隐私和生产覆盖验收。
