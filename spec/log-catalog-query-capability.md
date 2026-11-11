# 日志目录与查询能力规格

> 状态：四工具、私有身份上下文、目标绑定、脱敏观察与日志入账已实现并通过合成 mock 测试；真实生产身份/平台字段覆盖和真实学员联调尚未验收。
> 范围：`runtime/` 原生 TypeScript 工具、仓内 Catalog 与 `use-log-catalog` Skill。
> 关联：[当前架构](../docs/ARCHITECTURE.md)、[编排层实现](../docs/orchestration-layer-design.md)、[后续边界](../docs/multi-capability-expansion-plan.md)。

## 1. 当前工具与诊断位置

凭证同时配置时，Runtime 每轮通过共享 `CapabilitySession` 挂载：

| 工具 | 作用 | 证据地位 |
| --- | --- | --- |
| `resolve_log_target` | 按 store/appid/business 别名解析 Catalog，并绑定用户原文选择的唯一目标 | 路由信息，不是观测 |
| `count_cloud_logs` | 对已绑定目标执行同 query、同时间窗计数 | 规模信息，不是观测 |
| `search_cloud_logs` | 查询有界条目，脱敏并生成关联观察 | 只有身份匹配条目可入账 |
| `discover_client_sessions` | Runtime 私有注入身份，发现有候选身份字段的设备/会话目标 | 只有身份匹配条目可入账并确认平台 |

绑定源码的客户端计划仍为 `clientSteps=['observe','source']`。身份匹配查询或粘贴 hilog 解析可完成观察；`not_found`、`not_covered`、空结果、身份未匹配和查询失败统一降级，允许有条件的源码检查，但必须保留现场缺口。`ambiguous` 和仅 count 不放行。

新工单没有账本 `kind=log` 时仍先本地观察。只有账本真实日志条目满足后续 parallel 的日志观测门槛，普通工具文本不算。

## 2. 私有身份与隐私边界

Runtime 只从当前会话用户消息的明确标签提取学员编号、联系电话、traceId 和 requestId：

- 不使用 assistant 文本、其他会话或模型补全注入身份。
- 不同字段可跨用户消息合并；同一字段冲突时以最近一次明确输入为准。
- 原始学员标识只存在本轮私有 `LogToolCorrelation`，不出现在模型 schema 或工具定义中。
- `discover_client_sessions` 的模型参数只有 `time` 和 `size`；身份条件由 Runtime 在上游请求内构造。
- 单轮随机 HMAC 密钥只用于伪名，不持久化，不承诺跨轮伪名或日志 entry ID 可重放。

`ClientLogPrivacy` 在脱敏前匹配原始标识，输出只保留匹配事实、伪名和脱敏内容。日志正文、版本、时间、查询、工具事件、证据快照和案例归档都经过对应隐私边界。流式回复保留有界尾部后脱敏，避免标识被拆在多个 text delta 中；终态前刷新缓冲，保持文本顺序。用户原文仍保存在其会话中，供所有者查看和后续识别；不会为了脱敏而改写用户原始消息。

Compass 默认外发不包含原始学员编号或电话。traceId/requestId 是审批后用于请求关联的信息，不与学员隐私混为一谈；学员编号和电话仍不能单独满足 `correlationReady`。

## 3. Catalog 契约

当前只实现 Aliyun SLS：

```text
vendor=aliyun
  → account
  → collection（Project）
  → topic（Logstore）
  → appid
  → business / match 字段
```

appid 可 additive 声明：

```yaml
identity_fields:
  learner_id: [实际学员字段]
  phone: [实际电话字段]
  trace_id: [实际 trace 字段]
  request_id: [实际请求字段]
observation_fields:
  platform: [实际平台字段]
  platform_values:
    实际原始值: android
  version: [实际版本字段]
  device: [实际设备字段]
  session: [实际会话字段]
```

规则：

1. 只填写核实过的真实字段语义；缺省表示该目标不能进行身份发现或平台确认。
2. 身份发现只使用同时列入 `key_fields` 的身份字段，未声明可查询时不能假装上游支持。
3. `platform_values` 可登记精确原始值映射；通用 Android/iOS/HarmonyOS 值解析仍要求身份匹配。
4. 设备、会话和版本字段必须来自实际条目；store 名称、别名和目录说明不提供观察事实。
5. 当前生产 Catalog 尚未登记经核实的 HarmonyOS、“讲义邮寄”或通用身份/设备字段，不能据此宣称这些业务已覆盖。

## 4. 目标绑定与查询

### 4.1 用户选择绑定

`resolve_log_target` 唯一命中后，只有查询短语能在当前会话用户原文中逐字找到，才生成 `target_binding.status=confirmed`。Runtime 私有绑定 vendor/region/account/collection/topic/appid。

count/search 必须逐字携带已绑定坐标和 appid。模型改写业务词、遗漏 appid、发明坐标或切换坐标会返回 `log_target_unbound`，不会执行上游请求。Runtime 还会把查询约束到绑定 appid，不能把目标扩大成全店扫描。

### 4.2 身份发现

`discover_client_sessions` 遍历有身份字段配置的候选目标，最多查询 6 个目标，每目标最多 10 条。count 与后续 search 共用同一 query 和同一 epoch 时间窗；无结果不重复拉取详情。错误按目标收集并返回 `degraded`，未覆盖 store 和截断目标明确列出。

没有可用标识时返回 `log_identity_required`；没有可查询身份字段时返回 `not_covered`，不猜生产坐标。

### 4.3 时间与分页

- `time` 支持 `15m`、`1h`、`24h`、`7d` 等受控窗口。
- search `size` 默认 20，上限 50；发现上限 10；`from` 从 0 开始。
- 单次 HTTP 默认 15 秒，可配置 100–120000 毫秒；继承轮次 AbortSignal，不自动重试。
- count 已向上游传递 query，不再出现无条件 count 与条件 search 不一致。

## 5. 观察与证据契约

每条返回日志生成一个观察条目，包含：

- `entry_id`、脱敏 `excerpt`、`timestamp` 和脱敏字段；
- `matched_identifiers` 匹配事实；
- Runtime 控制的 `observation_context`：目标、环境、时间窗、分页、脱敏版本、脱敏 query、关联方法、设备/会话伪名、`observed_platform` 和 `observed_version`。

只有 `service_binding.status=confirmed` 且 `matched_identifiers` 非空的条目，才由 EvidenceLedger 的远程日志适配器逐条登记为 `kind=log`。`resolveDraft()` 恢复引用时透传 `observation_context`；模型草稿仍只能提交 ID、逐字摘录和 supports，不能伪造上下文。

以下结果不入账，也不能确认平台：

- `observation_status=empty` 或 `uncorrelated`；
- 仅 store/appid/Catalog 命中；
- 查询失败、权限不足、普通无身份日志；
- 平台字段未知或多平台冲突。

`observed_platform` 只在身份匹配的实际平台字段唯一时生成。设备发现汇总中任一冲突或未知分支都会使总平台保持 `unknown` 并保留限制。

正向根因若引用未关联远程日志，Runtime 返回 `log_evidence_unrelated`，报告不持久化、不静默修改 verdict。账本容量、跨轮恢复、淘汰和重读规则继续沿用 ADR 0003。

## 6. 真实验证边界

此前使用测试网关只验证了认证、网络、count 和单条 wildcard search。部分 Catalog appid 条件会被上游以“字段未配置为可检索 key”拒绝；本次 mock 框架测试没有重新验证该生产兼容问题，也没有执行真实学员查询。

当前可以声称：

- 合成身份与 mock HTTP 下，目标绑定、query/time 一致性、脱敏、平台冲突、关联入账、取消和错误防回显已通过测试。

当前不能声称：

- 真实学员、真实 HarmonyOS 或“讲义邮寄”查询已经可用；
- 生产 Catalog 字段、权限、脱敏 fixture 和诊断质量已验收；
- 已根据观察结果自动切换会话源码；精确版本快照选择与自动换绑是两个不同阶段。

真实联调需要另行授权和脱敏 fixture，不得在代码、测试、文档或输出中写入真实学员隐私、Token 或日志正文。

## 7. 验证入口

```bash
cd runtime
node --import tsx --test \
  test/log-center.test.ts \
  test/log-privacy.test.ts \
  test/evidence.test.ts \
  test/client-observation-gate.test.ts \
  test/capability-session.test.ts \
  test/orchestrated-round.test.ts
```

完整回归：`make test-runtime`。精确版本映射另跑 `test/repository-capability.test.ts`、`test/repository-routes.test.ts`。Catalog 或 Skill 变化还需检查对应编排测试；知识内容变化按项目要求执行知识校验和 MCP 专项测试。
