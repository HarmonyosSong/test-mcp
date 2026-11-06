# 本地开发免登设计（RUN_MODE）

> 状态：待实现  
> 日期：2026-11-06  
> 目标：本地开发免知音楼 SSO；线上继续统一登录  
> 范围：网页认证门禁；不含会话按工号隔离；知音楼 IM 开关不由本方案强改  
> 参考：`dev-agent` 的 `RUN_MODE=local|server` + `LocalIdentityProvider`  
> 关联：[`spec/sso-login-design.md`](../../../spec/sso-login-design.md)（原「本地免登不做」决策由本文件覆盖）

---

## 1. 背景与目标

Odyssey 网页已接入知音楼 SSO（Cookie 会话 + CSRF）。本地开发每次跳企业登录成本高。

目标：

1. 本机开发可免登进入诊断工作台。
2. 线上（含预发）必须走 SSO，默认安全。
3. 对齐 `dev-agent` 的运行模式思路，改动可控。

成功标准见文末验收清单。

---

## 2. 已确认决策

| 项 | 决定 |
|---|---|
| 实现形态 | 独立 `LocalIdentityProvider`，与现有 `SSOIdentityProvider` 并列 |
| 开关 | `HARMONY_AGENT_RUN_MODE=local\|server`，默认 **`server`** |
| authMode | 由 `runMode` 派生：`local` → `local`，否则 → `sso`；**不**另开 `AUTH_MODE` |
| 环境切换方式 | **分文件配置（方案 A）**：本地 `.env` 写 `local`；线上 `.env-prd` 写死 `server`。不自动推断环境 |
| 本地固定工号 | `347273`（不可配置） |
| issuer | `local.fixed-workcode` |
| local 监听 | 强制 `HARMONY_MASTRA_HOST=127.0.0.1`（覆盖配置中的监听地址） |
| 知音楼 IM | **不**被 `RUN_MODE` 强关；继续由现有 `YACH_ENABLED` 控制 |
| CSRF（local） | `/api/session` 返回空串 `csrfToken`；写请求不要求 CSRF |
| SSO 路由（local） | login / callback / logout 返回明确错误，避免误跳企业登录 |
| 前端退出（local） | 不展示「退出并跳转企业登出」 |

---

## 3. 配置与环境约定

### 3.1 变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARMONY_AGENT_RUN_MODE` | `server` | `local` 免登；`server` 走 SSO |

`authMode` 仅为派生只读概念（配置、`/api/session`、前端类型使用），不是独立环境变量。

### 3.2 文件约定

| 文件 | 期望值 |
|---|---|
| `.env.example` | 示例 `HARMONY_AGENT_RUN_MODE=local`，并注释线上必须用 `server` |
| 开发者本机 `.env` | `local`（gitignore，一次配好） |
| `.env-prd` | 写死 `server` |

日常开发**不需要**在 local/server 之间来回改同一文件；换环境靠换/复制对应 env。

### 3.3 local 模式覆盖

当 `runMode === 'local'`：

1. 强制 `host = 127.0.0.1`
2. 选择 `LocalIdentityProvider`
3. 不要求 SSO 凭据已配置

当 `runMode === 'server'`：

1. 行为与现网 SSO 一致
2. 缺 SSO 凭据时鉴权相关接口仍 `503`

---

## 4. 后端设计

### 4.1 LocalIdentityProvider

新增 `runtime/src/auth/local.ts`（或等价路径）：

- `resolve(requestContext)`：**忽略** Cookie / CSRF / 浏览器自报身份
- 固定返回：
  - `subject`: `347273`
  - `displayName`: `347273`
  - `issuer`: `local.fixed-workcode`
- 安全约束（对齐 `dev-agent`）：
  - 仅允许 loopback：客户端 host 与请求 hostname 属于 `{127.0.0.1, localhost, ::1}`
  - 非 `GET` / `HEAD` / `OPTIONS`：要求 `Origin === publicBaseUrl`（去尾斜杠后比较）
  - 违规 → `403`

### 4.2 装配

`runtime/src/app.ts`：

```text
identityProvider =
  config.authMode === 'local'
    ? new LocalIdentityProvider({ publicBaseUrl })
    : new SSOIdentityProvider({ ...ssoSettings })
```

`requireIdentity` / 业务路由只依赖统一的 `resolve` 能力，不直接依赖 SSO HTTP 细节。

### 4.3 /api/session

**local：**

```json
{
  "authMode": "local",
  "csrfToken": "",
  "identity": {
    "subject": "347273",
    "displayName": "347273",
    "issuer": "local.fixed-workcode"
  }
}
```

**server：** 保持现有字段与行为（`authMode: "sso"` + 真实 csrf + SSO identity）。

### 4.4 Auth 路由在 local 下的行为

| 路由 | local | server |
|---|---|---|
| `GET /auth/sso/login` | `400`，说明当前为本地免登 | 现有 303 → SSO |
| `GET /auth/sso/callback` | `400` | 现有换票建会话 |
| `POST /auth/logout` | `400`（前端 local 不调用） | 现有清会话 + SSO logoutUrl |
| `GET /api/session` | 固定本地身份 | SSO 会话 |

实现上可通过「auth 路由工厂接收 provider + authMode」或 Local provider 对 SSO 专用方法抛错；优先保持 `createAuthRoutes` 可读、少分支。

### 4.5 类型与中间件

- 抽出最小 `IdentityProvider` 接口（至少 `resolve`；session/csrf 按需）
- `AuthVariables.identityProvider` 类型改为该接口（或联合类型），避免业务代码写死 SSO 类

---

## 5. 前端设计

### 5.1 类型

`ServerSession.authMode: 'sso' | 'local'`

### 5.2 SessionGate

- `authMode === 'local'`：允许空 `csrfToken`；校验仍要求 `identity.subject`
- 不触发企业 SSO 跳转
- `localhost` → `127.0.0.1` 重定向：local 模式下可保留（与强制本机监听一致），避免双 host 混用

### 5.3 请求与退出

- `authenticatedFetch`：仅在有非空 csrf 时附加 `X-CSRF-Token`（现逻辑已满足）
- local：UI **不展示**企业登出入口；无需调用 `/auth/logout`

---

## 6. 文档与规格同步

- 本文件为免登方案权威说明
- 更新 `spec/sso-login-design.md` 决策表：「本地免登」改为「由 `HARMONY_AGENT_RUN_MODE` 控制；默认 server」
- `.env.example` / README 配置表补充 `HARMONY_AGENT_RUN_MODE`
- 不改知音楼 IM 规格（`yach-im-lightweight.md`）

---

## 7. 测试计划

| 用例 | 期望 |
|---|---|
| `RUN_MODE=local` → `GET /api/session` | 200，`authMode=local`，subject=`347273`，csrf 空 |
| local + 业务 API（模拟 loopback） | 200，无需 Cookie |
| local + 非 loopback / 错误 Origin 写请求 | 403 |
| local + `/auth/sso/login` | 非 303 到企业 SSO；明确错误 |
| `RUN_MODE=server` + 已登录会话 | 与现有 `sso-auth` 测试一致 |
| `RUN_MODE=server` + 缺 SSO 凭据 | login/鉴权相关 503 |
| 前端类型 / SessionGate | local 空 csrf 可进入工作台 |

---

## 8. 验收清单

1. 本机 `.env` 设 `HARMONY_AGENT_RUN_MODE=local`，打开工作台无需企业登录即可诊断。
2. `.env-prd`（或线上 `.env`）为 `server` 且 SSO 配齐时，行为与现网一致。
3. 默认未设置 `RUN_MODE` 时按 `server`，不会意外免登。
4. local 下非本机访问或非法 Origin 写请求被拒绝。
5. 知音楼 IM 启停仍只看现有 Yach 配置，不因 `local` 被强制关闭。

---

## 9. 非目标

- 可配置本地工号
- 按工号做会话/数据隔离
- Redis / 多实例共享会话
- 自动根据 `NODE_ENV` 或监听地址推断 auth 模式
- 用 `RUN_MODE` 强关知音楼 IM
