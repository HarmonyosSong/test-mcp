# log-mcp

独立运行的日志查询 MCP 服务。唯一职责：**把日志取回来**，不承载任何调用方的业务语义。

与 Agent Node 进程互不影响：独立端口（默认 `8766`）、独立配置前缀（`LOG_MCP_*`）、独立数据目录。

## 范围

| 维度 | 说明 |
| --- | --- |
| 工具面 | 14 个：日志中心 7 + 云日志 6 + 聚合 `search_both_logs` 1 |
| 云日志支持 | 当前仅阿里云 SLS（`vendor=tencent` 报错） |
| 鉴权 | ctl 颁发长期 Bearer token（带过期，库内只存哈希）；无 HTTP 换票 |
| 部署形态 | 独立 HTTP MCP 服务（Starlette + uvicorn），非 stdio 子进程 |
| 边界 | 不含日志地图 / uid 注入 / evidence 标记 / 二次截断 |

完整设计见 `docs/superpowers/specs/2026-11-17-logquery-mcp-design.md`。

## 目录结构

```text
log-mcp/
  pyproject.toml
  manage.py                       # 兼容入口（推荐 uv run start/stop/status）
  src/log_mcp/
    config.py                     # 根目录 .env 的 LOG_MCP_* > 内置默认
    logging_setup.py              # 按轮次实时切分日志（一轮问答一个文件）
    round_context.py              # 轮次头 → contextvar（ASGI 中间件）
    server.py                     # MCPServer 装配 + Starlette + uvicorn 入口
    ...
  tests/
```

配置统一在仓库根目录 `.env`（以及 `.env.example` / `.env-prd`），**不再**使用 `config/log-mcp.local.json`。

## 快速开始

推荐：在项目根用 Make，和 Agent 一起起：

```bash
# 根目录 .env 配好 LOG_MCP_* 后
make setup          # 含 uv sync --project log-mcp
make dev-api        # 后台起 log-mcp(:8766) + 前台 Agent(:8000)
# Ctrl+C 会停掉 log-mcp
```

仅 log-mcp：

```bash
make dev-log-mcp    # 后台
make stop-log-mcp
# 或进入目录前台跑：
cd log-mcp && uv run start
uv run check        # 健康 + 14 工具名
```

## 本地 IDE 接入

```bash
cd log-mcp
uv run start
curl -s http://127.0.0.1:8766/health
# 期望：{"status":"ok","auth":"disabled"} 或鉴权开启时 status=ok
```

### 颁发 Token（鉴权开启时）

```bash
cd log-mcp
uv run client issue --client-id odyssey-runtime --description "Runtime" --days 180
# 明文 token 仅打印一次 → 写入调用方 LOG_MCP_BEARER_TOKEN
uv run client list
uv run client revoke --client-id odyssey-runtime
```

本地 `LOG_MCP_AUTH_DISABLED=true` 时可跳过。

### Cursor / VS Code（`mcp.json`）

```json
{
  "mcpServers": {
    "log-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:8766/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

## 端点

| 端点 | 工具数 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `/mcp` | 14 | Bearer | **对外唯一入口** |
| `/mcp/logcenter` | 7 | Bearer | 调试：只测日志中心 |
| `/mcp/cloud` | 6 | Bearer | 调试：只测云日志 |
| `/health` | — | 无 | 存活探针 |

## 配置

全部写在项目根 `.env`，前缀 `LOG_MCP_*`。优先级：

```text
进程环境变量 > 根目录 .env > 内置默认
```

只区分 **prod / test** 两套网关凭据；`LOG_MCP_ENV` 决定启动默认环境。

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `LOG_MCP_HOST` | 监听地址 | `127.0.0.1` |
| `LOG_MCP_PORT` | 端口 | `8766` |
| `LOG_MCP_ENV` | 默认环境 `prod`/`test` | `test` |
| `LOG_MCP_DATA_ROOT` | 数据根 | `${HARMONY_AGENT_DATA_ROOT}/log-mcp` 或 `.data/log-mcp` |
| `LOG_MCP_PROD_APPID` / `LOG_MCP_PROD_APPSECRET` | 生产网关凭据 | — |
| `LOG_MCP_TEST_APPID` / `LOG_MCP_TEST_APPSECRET` | 测试网关凭据 | — |
| `LOG_MCP_PROD_BASE_URL` | 生产网关 | `https://logcenter-api.tal.com/api` |
| `LOG_MCP_TEST_BASE_URL` | 测试网关 | `https://logcenter-api-test.tal.com/api` |
| `LOG_MCP_TIMEOUT_MS` | 单次上游 HTTP 超时 | `30000` |
| `LOG_MCP_AUTH_DISABLED` | 关鉴权（仅回环生效） | `false` |
| `LOG_MCP_CLOUDLOG_VENDOR` | 云日志厂商 | `aliyun` |
| `LOG_MCP_CLOUDLOG_REGION` | 默认 region | `cn-beijing` |
| `LOG_MCP_CLOUDLOG_ACCOUNT` | 默认 account | `1743276692096170` |
| `LOG_MCP_CLOUDLOG_COLLECTION` | 默认 collection | `pysy-front-log` |

## 调用日志（按轮次实时切分）

工具调用与运行日志同时打到：

1. 控制台（stdout）
2. 数据目录按轮次文件（**一轮问答一个文件，秒级粒度**）

```text
<data_root>/logs/log-mcp-round-YYYY-MM-DD_HH-MM-SS.log
```

Runtime 每轮诊断建立 log-mcp 连接时带两个头：

| 头 | 含义 |
| --- | --- |
| `X-Odyssey-Round-Start` | 本轮开始时刻（epoch 毫秒；也接受 10 位秒） |
| `X-Odyssey-Round-Label` | 本轮标识 `run=… conv=… msg=…`，只写进文件头注释 |

log-mcp 收到该轮**第一条日志时立即建文件**，文件名就是本轮开始时刻；本轮后续的工具调用
`tool#N BEGIN/END`、上游 HTTP 请求、MCP 会话日志全部追加进同一文件。

本地默认：`troubleshoot-odyssey/.data/log-mcp/logs/log-mcp-round-2026-11-19_15-50-20.log`  
容器（挂卷后）：`/data/troubleshoot-odyssey/log-mcp/logs/log-mcp-round-YYYY-MM-DD_HH-MM-SS.log`

命名规则：

| 情况 | 文件名 | 说明 |
| --- | --- | --- |
| 一轮问答 | `log-mcp-round-2026-11-19_15-50-20.log` | 时间 = 该轮开始时刻（年月日_时分秒） |
| 同一秒两轮 | `log-mcp-round-2026-11-19_15-50-20_02.log` | 顺延 `_02`、`_03`，不覆盖已有文件 |
| 进程启停 / 无轮次上下文 | `log-mcp-2026-11-19_15-48-15.log` | 兜底文件，一次进程启动一个，跨零点不切 |
| 后台模式 stdout/stderr | `log-mcp-2026-11-19_15-48-14.out.log` | 与兜底文件同一时刻，`.out` 后缀区分 |

- 文件名按字典序排列 **就等于轮次先后顺序**：`ls -1 logs/log-mcp-round-*` 直接看时间线，`| tail -1` 是最新一轮。
- 想复盘某一轮：直接打开该轮文件，`grep -n "tool#"` 即本轮完整调用链，不会混入别轮。
- 手动调试也可以带头：`curl -H 'X-Odyssey-Round-Start: 1795074620000' ...`；不带头的请求写兜底文件。
- 同一轮最多同时打开 32 个文件句柄，超出按 LRU 关流（文件保留，再写时追加打开）。

## 进程管理

```bash
uv run start              # 默认前台
uv run start --background # 后台
uv run stop
uv run restart
uv run status
uv run check              # 健康 + 14 工具名
```

容器内由 Dockerfile 的 `CMD`（镜像内 `start-services.sh`）后台拉起本服务，再前台启动 Agent；两者互不影响。部署侧只需 Dockerfile + 平台注入的 `.env`。

## 测试

```bash
uv run pytest
uv run ruff check .
```

## 不做

| 不做 | 原因 |
| --- | --- |
| 日志地图 / 业务别名词典 | 业务语义归调用方 |
| uid / 手机号 / traceId 注入 | 同上 |
| evidence / observation 标记 | 裁决权归调用方 |
| 结果二次截断 | 掩盖信息，导致误判 |
