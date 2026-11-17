# log-mcp

独立运行的日志查询 MCP 服务。唯一职责：**把日志取回来**，不承载任何调用方的业务语义。

## 范围

| 维度 | 说明 |
| --- | --- |
| 工具面 | 14 个：日志中心 7 + 云日志 6 + 聚合 `search_both_logs` 1 |
| 云日志支持 | 当前仅阿里云 SLS（`vendor=tencent` 报错） |
| 鉴权 | OAuth 2.1 client_credentials，短期 access_token + 哈希存储 |
| 部署形态 | 独立 HTTP MCP 服务（Starlette + uvicorn），非 stdio 子进程 |
| 边界 | 不含日志地图 / uid 注入 / evidence 标记 / 二次截断 |

完整设计见 `docs/superpowers/specs/2026-11-17-logquery-mcp-design.md`。

## 目录结构

```text
log-mcp/
  pyproject.toml
  manage.py                       # 兼容入口（推荐 uv run start/stop/status）
  src/log_mcp/
    config.py                     # env > file > default
    server.py                     # MCPServer 装配 + Starlette + uvicorn 入口
    auth.py                       # Bearer 校验 ASGI 包装器
    oauth.py                      # /oauth/token + /oauth/revoke
    token_store.py                # sqlite3 两张表
    errors.py                     # LogMcpToolError + isError:true 结构
    auth_context.py               # 请求级 scope 强制
    clients/
      sign.py                     # md5(appid&ts + appsecret)
      logcenter.py                # 日志中心 7 方法
      cloudlog.py                 # 云日志 6 方法
      time_range.py               # 时间解析
      redact.py                   # 脱敏（两侧共用）
    tools/
      logcenter.py                # 7 工具注册
      cloudlog.py                 # 6 工具注册
      aggregate.py                # search_both_logs：并行 + 失败隔离
  config/
    log-mcp.local.json.example    # 配置模板，提交
  tests/
```

## 快速开始

```bash
# 1. 安装依赖
uv sync

# 2. 复制配置模板并填入凭据
cp config/log-mcp.local.json.example config/log-mcp.local.json
# 编辑 log-mcp.local.json：填入 gateway.prod / gateway.test 的 appid/appsecret

# 3. 注册一个 OAuth client（输出 client_secret，仅此一次可见）
uv run client register --client-id odyssey --description "troubleshoot-odyssey"

# 4. 启动服务（默认前台，日志打终端；Ctrl+C 停止）
LOG_MCP_AUTH_DISABLED=true uv run start

# 5. 另开终端做健康检查 + MCP 协议验证（确认 14 个工具名齐全）
uv run check
```

## 本地 IDE 接入（推荐先这样测）

本地把其他 IDE / Cursor 接到本机 MCP 时，建议临时关闭鉴权（仅回环生效）：

```jsonc
// config/log-mcp.local.json
{ "auth": { "disabled": true } }
```

然后启动：

```bash
cd log-mcp
LOG_MCP_AUTH_DISABLED=true uv run start
# 另开终端：
curl -s http://127.0.0.1:8766/health
# 期望：{"status":"ok","auth":"disabled"}
```

### Cursor / VS Code（`mcp.json`）

```json
{
  "mcpServers": {
    "log-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:8766/mcp"
    }
  }
}
```

Cursor：项目 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`。  
VS Code（Copilot / MCP 扩展）：按扩展文档放到对应 `mcp.json`。

接上后应能看到 **14 个工具**（`search_services`、`query`、`cloud_search`、`search_both_logs` 等）。

### Claude Desktop / 其他支持 Streamable HTTP 的客户端

URL 填：`http://127.0.0.1:8766/mcp`  
传输：Streamable HTTP（不是 stdio）。

若客户端不支持 HTTP MCP，可用 [mcp-remote](https://www.npmjs.com/package/mcp-remote) 等桥接（视客户端能力而定）。

### 需要 Bearer 时（auth.disabled=false）

先注册 client 并换 token，再在 MCP 配置里加 headers：

```bash
uv run client register --client-id ide-local --scopes logs:read
# 记下 client_secret（仅此一次）

TOKEN=$(curl -s -X POST http://127.0.0.1:8766/oauth/token \
  -d "grant_type=client_credentials" \
  -d "client_id=ide-local" \
  -d "client_secret=<your-secret>" | jq -r .access_token)
echo "$TOKEN"
```

```json
{
  "mcpServers": {
    "log-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:8766/mcp",
      "headers": {
        "Authorization": "Bearer <access_token>"
      }
    }
  }
}
```

注意：token 默认 1 小时过期，过期后要重新换；本地联调优先用 `auth.disabled=true`。

### 续期约定（生产调用方）

- access_token 有效期 1 小时，距过期 < 5 分钟时提前续期
- 收到 401 时立即重新换 token 并重试一次
- `client_secret` 永不轮换；要止损就吊销 client：`uv run client revoke --client-id odyssey`

## 端点

| 端点 | 工具数 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `/mcp` | 14 | Bearer | **对外唯一入口** |
| `/mcp/logcenter` | 7 | Bearer | 调试：只测日志中心 |
| `/mcp/cloud` | 6 | Bearer | 调试：只测云日志 |
| `/health` | — | 无 | 存活探针 |
| `/oauth/token` | — | 无 | 换取 access_token |
| `/oauth/revoke` | — | 无 | 吊销令牌 |

## 工具清单

### 日志中心（7）

| 工具 | 说明 |
| --- | --- |
| `search_services` | 关键词搜服务，返回 authorized/unauthorized/not_found 三级 |
| `list_services` | 按权限分页列表 |
| `get_fields` | 获取 index=true 可查询字段 |
| `get_storage_type` | es/tls/cls/bls 路由别名 |
| `count` | 统计总数，不返回内容 |
| `query` | Lucene 检索（page 从 1 起，每页 40） |
| `dsl_search` | 透传 ES Query Body（禁 script，from+size≤10000） |

### 云日志（6）

| 工具 | 说明 |
| --- | --- |
| `cloud_accounts` | 列出 vendor 下账号 |
| `cloud_collections` | 列出账号下日志集 |
| `cloud_topics` | 列出账号下全部 topic（自带 collection/region） |
| `cloud_count` | 统计 topic 总量（不支持 query 过滤） |
| `cloud_search` | SLS 类 SQL 检索（from 从 0 起偏移量） |
| `cloud_probe` | 探测 collection 可访问性与延迟 |

### 聚合（1）

| 工具 | 说明 |
| --- | --- |
| `search_both_logs` | 两侧并行 + 单侧/单 topic 失败隔离；不传 cloud 只查日志中心，传 {} 全量扫 topic |

## `time` 参数格式

`count` / `query` / `cloud_count` / `cloud_search` / `search_both_logs` 共用同一解析器，解析失败返回 `bad_request`（无效的时间范围）。

| 类型 | 示例 |
| --- | --- |
| 相对 | `15m`、`1h`、`3d`、`1w` |
| 自然语言 | `今天`、`昨天`、`本周`、`过去3天` |
| 同日时段 | `今天9:00到10:00`、`2026-11-11 07:00-07:40` |
| Agent 常见完整写法 | `2026-11-11 07:00:00 to 2026-11-11 07:40:00` |

分隔符支持：`到` / `-` / `至` / `to` / `~`；时间可带可选秒 `:SS`。

## 配置

配置文件 `config/log-mcp.local.json`（不提交 git），环境变量 `LOG_MCP_*` 优先覆盖。

日志中心与云日志共用 `gateway`（网关 + appid/appsecret），按环境区分；云日志仅额外配置 `vendor` + `defaults`：

- `gateway.prod` → `https://logcenter-api.tal.com/api`
- `gateway.test` → `https://logcenter-api-test.tal.com/api`

`env` **默认 `test`**。覆盖方式（优先级从高到低）：

1. 环境变量 `LOG_MCP_ENV=prod`
2. 配置文件 `"env": "prod"`
3. 内置默认 `test`

启动 `env` 决定：工具 `env` 入参缺省值、云日志用哪套网关+凭据。工具仍可显式传 `env=test|prod` 临时切换日志中心侧。

| 环境变量 | 对应配置 | 默认 |
| --- | --- | --- |
| `LOG_MCP_HOST` | host | `127.0.0.1` |
| `LOG_MCP_PORT` | port | `8766` |
| `LOG_MCP_ENV` | env | `test`（可覆盖为 `prod`） |
| `LOG_MCP_DATA_ROOT` | dataRoot | `${HARMONY_AGENT_DATA_ROOT}/log-mcp`，否则复用项目根 `troubleshoot-odyssey/.data/log-mcp` |
| `LOG_MCP_PROD_APPID` | gateway.prod.appid | — |
| `LOG_MCP_PROD_APPSECRET` | gateway.prod.appsecret | — |
| `LOG_MCP_TEST_APPID` | gateway.test.appid | — |
| `LOG_MCP_TEST_APPSECRET` | gateway.test.appsecret | — |
| `LOG_MCP_PROD_BASE_URL` | gateway.prod.baseUrl | `https://logcenter-api.tal.com/api` |
| `LOG_MCP_TEST_BASE_URL` | gateway.test.baseUrl | `https://logcenter-api-test.tal.com/api` |
| `LOG_MCP_LOGCENTER_BASE_URL` | gateway.prod.baseUrl | 兼容旧名，等价于 `LOG_MCP_PROD_BASE_URL` |
| `LOG_MCP_TIMEOUT_MS` | timeoutMs | `30000`（单次上游 HTTP 调用） |
| `LOG_MCP_AUTH_DISABLED` | auth.disabled | `false`（仅回环地址生效） |
| `LOG_MCP_CLOUDLOG_VENDOR` | cloudlog.vendor | `aliyun` |
| `LOG_MCP_CLOUDLOG_REGION` | cloudlog.defaults.region | `cn-beijing` |
| `LOG_MCP_CLOUDLOG_ACCOUNT` | cloudlog.defaults.account | `1743276692096170` |
| `LOG_MCP_CLOUDLOG_COLLECTION` | cloudlog.defaults.collection | `pysy-front-log` |

## 进程管理

```bash
uv run start              # 默认前台：日志打终端，启动会打印环境变量与解析配置；Ctrl+C 停
uv run start --background # 后台守护（-d）；日志写入 dataRoot/logs/log-mcp.log
uv run stop               # 优雅停止后台进程（SIGTERM ≤ 25s）
uv run restart            # 默认前台重启
uv run restart -d         # 后台重启
uv run status             # 查看运行状态
uv run check              # 健康 + MCP 协议验证（14 个工具名齐全）
```

六项保护：PID 防复用、端口占用保护、健康检查、MCP 协议级验证、优雅停止、文件锁互斥。  
前台模式不写后台 PID 记录；若已有后台进程，需先 `uv run stop` 再 `uv run start`。

启动后每次工具调用会打工具链日志：`tool#N BEGIN name args=...` → `tool#N END ...`。

> 旧写法 `uv run python manage.py start|restart [--background]` 仍可用，推荐短命令。

### 测试 / 生产环境如何注入

两层环境，别混：

| 层 | 作用 | 怎么设 |
| --- | --- | --- |
| **启动默认 `env`** | 工具入参 `env` 缺省值；云日志用哪套网关+凭据 | `LOG_MCP_ENV=test\|prod`，或配置文件 `"env"`；默认 `test` |
| **单次工具入参 `env`** | 仅日志中心侧（`query`/`count`/…）临时切环境 | 调用工具时传 `env=prod` 或 `env=test` |

凭据按环境分两套，启动时都可注入（也可用 `config/log-mcp.local.json`）：

```bash
# 测试环境（默认）
LOG_MCP_ENV=test \
LOG_MCP_TEST_APPID=xxx \
LOG_MCP_TEST_APPSECRET=yyy \
LOG_MCP_AUTH_DISABLED=true \
uv run start

# 生产环境
LOG_MCP_ENV=prod \
LOG_MCP_PROD_APPID=xxx \
LOG_MCP_PROD_APPSECRET=yyy \
LOG_MCP_AUTH_DISABLED=true \
uv run start
```

配置文件示例：

```json
{
  "env": "test",
  "auth": { "disabled": true },
  "gateway": {
    "test": { "appid": "...", "appsecret": "..." },
    "prod": { "appid": "...", "appsecret": "..." }
  }
}
```

优先级：`环境变量 > 配置文件 > 内置默认`。启动日志里会打印「哪些 `LOG_MCP_*` 已注入」和「解析后的 resolved settings」。

### 带环境变量启动 / 重启

```bash
cd /path/to/troubleshoot-odyssey/log-mcp

# 前台（默认）
LOG_MCP_AUTH_DISABLED=true uv run start

# 切生产默认环境后前台重启
LOG_MCP_ENV=prod LOG_MCP_AUTH_DISABLED=true uv run restart

# 后台跑
uv run start --background
LOG_MCP_ENV=prod uv run restart -d
```

注意：已经在跑的进程**不会**自动吃到你新 export 的变量；必须重新 `start`/`restart`。

## Token CLI

```bash
uv run client register --client-id odyssey --description "..." [--scopes logs:read|logs:probe]
uv run client revoke   --client-id odyssey
uv run client list
```

`client register` 输出的 `client_secret` 仅此一次可见，丢失只能吊销重建。

## scope 强制

| scope | 允许的工具 |
| --- | --- |
| `logs:read` | 全部 14 个（默认） |
| `logs:probe` | 仅 `cloud_probe` / `list_services` / `get_fields` |

## 测试

```bash
uv run pytest                    # 全部测试
uv run ruff check .              # 规范检查
```

测试覆盖：脱敏、时间解析、DSL 校验、签名、OAuth、聚合隔离、工具层、scope 强制、调试 path。

## 安全要求

- `client_secret` 与 `access_token` 均用 `hmac.compare_digest` 常量时间比较
- 存储中只有 sha256 摘要，无明文
- `Authorization` 头不进日志，审计只记 `client_id`
- 401 不区分「token 不存在」与「已过期」，避免探测
- 令牌校验在 MCP 协议层之前完成

## 不做

| 不做 | 原因 |
| --- | --- |
| 日志地图 / 业务别名词典 | 业务语义归调用方 |
| uid / 手机号 / traceId 注入 | 同上 |
| evidence / observation 标记 | 裁决权归调用方 |
| 结果二次截断 | 掩盖信息，导致误判 |
| `index_status` | 查询前体检属平台/运维职责 |
