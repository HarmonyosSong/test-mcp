# 知音楼接收桥（Odyssey）

此目录只将 TalMsg SDK 已认证的 `recvMsg` 转发到 Odyssey runtime 父进程，不包含业务诊断、模型调用或发信。回信由 `runtime/src/channels/yach/oapi.ts` 完成。需要 Node.js ≥ runtime 要求（≥22.13）。

## 安装

```sh
cd runtime/yach-bridge
npm ci --ignore-scripts
node --test bridge.test.cjs
```

也可通过仓库根目录 `make setup` 一并安装。仅依赖 `ws`（见 `package-lock.json`）。禁止执行第三方安装脚本。

SDK 来源及校验值见 `vendor/provenance.json`。桥启动前验证交付文件 SHA256。

## 运行约定

由 `YachChannel` → `YachBridge` 启动；凭据仅从匿名 stdin 管道传入，不使用命令参数，也不继承应用环境凭据或 `NODE_OPTIONS`。stdout 仅供父进程读取。

在仓库根 `.env`（或服务器上由 `.env-prd` 复制而来的 `.env`）配置：

| 变量 | 说明 |
|---|---|
| `HARMONY_AGENT_YACH_ENABLED=true` | 开启 IM 渠道（必填开关） |
| `HARMONY_AGENT_YACH_APP_KEY` / `_SECRET` | 数字伙伴「API 密钥」页 |
| `HARMONY_AGENT_YACH_BASE_URL` | 默认 `https://yach-oapi.zhiyinlou.com` |
| `HARMONY_AGENT_YACH_DISPATCH_URL` | SDK 调度，默认 `https://chatconf.msg.xescdn.com/v4/proxy/config` |
| `HARMONY_AGENT_YACH_BRIDGE_PATH` | 可选；默认本目录 `bridge.cjs` |

兼容回退：未设 `HARMONY_AGENT_YACH_APP_KEY/SECRET` 时可写裸名 `YACH_APP_KEY` / `YACH_APP_SECRET`；**开关没有裸名回退**，必须用 `HARMONY_AGENT_YACH_ENABLED`。

第一期仅私聊；身份取自已认证事件的 `userJson.workCode`。会话映射与去重在进程内存中，**单副本**部署。

## 上线前

1. 数字伙伴已**发布**且为**长连接**模式。  
2. 进程能访问 OAPI、调度域名及调度返回的 WSS。  
3. 无需为本应用登记 IM HTTP 回调地址。  
4. 真人私聊联调见 `spec/yach-im-lightweight.md` 第 9 节。
