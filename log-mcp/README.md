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
    logging_setup.py              # 按日文件日志
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

## 调用日志（按日文件）

工具调用与运行日志同时打到：

1. 控制台（stdout）
2. 数据目录按日文件：

```text
<data_root>/logs/log-mcp-YYYY-MM-DD.log
```

本地默认：`troubleshoot-odyssey/.data/log-mcp/logs/log-mcp-2026-11-17.log`  
容器（挂卷后）：`/data/troubleshoot-odyssey/log-mcp/logs/log-mcp-YYYY-MM-DD.log`

内容含 `tool#N BEGIN/END` 调用链，跨日自动切新文件。

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
