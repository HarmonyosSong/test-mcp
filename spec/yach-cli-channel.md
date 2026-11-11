# 知音楼 IM：Yach-CLI 渠道接入

> 状态：已批准，按本文落地  
> 日期：2026-11-10  
> 取代：[`yach-im-lightweight.md`](./yach-im-lightweight.md)（SDK 薄桥 + OAPI 进度卡）  
> 关联：网页 SSO [`sso-login-design.md`](./sso-login-design.md)；Compass A2A [`compass-a2a-integration.md`](./compass-a2a-integration.md)

## 1. 目标

1. 能收到数字人收到的消息（私聊 + 群 @）。
2. 支持读群列表 / 群历史，并响应群 @。
3. **全部用 `yach-cli` 实现**；不用 `yach-mcp`；替换现有 SDK 桥与 OAPI 直调出站。

## 2. Agent 怎么用（定死）

**不是 Skill，不是 MCP。**

属于 runtime **渠道适配层**（现有 `YachChannel` 角色不变）：

- 进程启动拉起 `yach-cli event consume`，读 NDJSON → 解析 → 排队 → `runDiagnosisRound`
- 群 @ 时渠道层先 `yach-cli im history`，摘要注入本轮用户上下文，再进诊断
- 回信：`yach-cli im send --robot`

诊断 Agent **不感知** yach-cli；不把收信/发信做成模型工具。

```text
yach-cli event (入站)
    → YachChannel（解析 / 排队 / 群@拉历史）
    → DiagnosisAgent
    → yach-cli im send（出站回信）
```

## 3. 能力与命令

| 能力 | 实现 |
|---|---|
| 收私聊 | `event consume --event-type im.message.receive` |
| 响应群 @ | 同上（含群 @）；回群 `im send --robot --group-id …` |
| 读群历史 | @ 时 `im history --group-id …`，注入本轮上下文 |
| 列群（可选） | `im robot-groups` |

平台限制：群历史约近 24h、最多约 100 条；新群可能返回空。

## 4. 替换范围

**删/停用**

- `runtime/yach-bridge/`（TalMsg SDK 薄桥）
- `runtime/src/channels/yach/bridge.ts`
- `oapi.ts` / `progress.ts` 中 OAPI 进度卡与直调发信（进度改普通 markdown 或省略）

**改**

- `parse.ts`：适配 CLI event（`data` 可能二次 JSON；`conversationType` 1/2；群 @）
- `channel.ts`：消费 CLI 事件流；群按 `group_id`；@ 触发诊断；回信走 CLI
- 新增 `cli.ts`：`event consume` 子进程 + `im send` / `im history` / `im robot-groups`
- 配置与 `.env.example`：保留 app key/secret；增加 CLI 路径；去掉 SDK 专用项

**保留**

- 员工串行队列、`/new` `/stop`、会话映射、`runDiagnosisRound`、网页诊断路径

## 5. 配置与部署授权

| 变量 | 说明 |
|---|---|
| `HARMONY_AGENT_YACH_ENABLED` | `true` 启动渠道 |
| `HARMONY_AGENT_YACH_APP_KEY` / `_SECRET` | 数字伙伴应用凭证（运行时注入，勿写入镜像） |
| `HARMONY_AGENT_YACH_CLI_PATH` | 可选，默认 `yach-cli` |
| `HARMONY_AGENT_YACH_ROBOT_ID` | 可选备注 |

去掉：`DISPATCH_URL`、`CHANNEL_APP_ID`、`BIZ_ID`、`BRIDGE_PATH`、`NODE_PATH`、`VERSION_AREA`、`BASE_URL`（不再直调 OAPI）。

### 授权模型

- 只要**应用凭证**（机器人身份）。终端用户私聊 / 群 @ **不扫码、不授权**。
- 本方案不使用 `yach-cli login` / `--for-user`。

### 容器 / 反复构建怎么 init（定死）

**不要**依赖人工 SSH 执行一次，也**不要**把 appsecret 打进镜像。

正确做法：镜像只安装 `yach-cli` 二进制；密钥由编排注入环境变量；**渠道启动时**由 runtime 自动执行：

```bash
yach-cli config init --app_key "$HARMONY_AGENT_YACH_APP_KEY" --app_secret "$HARMONY_AGENT_YACH_APP_SECRET"
```

每次容器冷启动都可再跑一遍（幂等覆盖本地 CLI 配置），然后拉起 `event consume`。  
不要求挂载 `~/.yach-cli` 才能工作；若挂卷仅作优化（少重复写密钥文件），不是硬依赖。

约束：同一 `app_key` 的 event Bus **单副本**；多副本会抢长连接。

### Docker

在原平台 Dockerfile 上补充（见仓库根 [`Dockerfile`](../Dockerfile)）：去掉 `yach-bridge`；运行镜像安装钉版本 `yach-cli`。`.env` 由平台挂载，runtime 启动读配置后自动 `config init`，Dockerfile 不必再写一遍密钥/init。长连接仅 amd64。

## 6. 验收

- 私聊文本进诊断并回 markdown
- 群 @ 进诊断并回群
- @ 时可带近期群历史（平台限制内）
- 不启 yach-mcp；不启旧 SDK 桥

## 7. 参考

- CLI 概览：https://yach-open.zhiyinlou.com/cli/
- 长连接事件：https://yach-open.zhiyinlou.com/cli/reference/event.html
- 即时消息：https://yach-open.zhiyinlou.com/cli/reference/im.html
