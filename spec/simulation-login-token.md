# 学员模拟登录 Token 能力

> 状态：已批准，按本文落地  
> 日期：2026-11-25  
> 关联：知音楼渠道 [`yach-cli-channel.md`](./yach-cli-channel.md)；查学员档案 Skill `lookup-learner-profile`  
> 参考：Compass / cloudlearn-devtools API MCP（仅查 Token 与渠道出图契约，不整包照搬）

## 1. 目标

1. 按用户给出的学员标识查询**模拟登录 Token**。
2. 将 Token 编成二维码；需要外链时上传私有 COS，得到短时签名 URL。
3. 经 **Web** 与 **知音楼** 回复用户（Token 原文 + 可选二维码）。

## 2. 非目标

- 新建 Token / 包装用 MCP 服务（禁止「MCP 套 MCP」）  
- 向模型暴露完整 `api_catalog` / `api_describe` / `api_query` 或其它业务 `api_id`  
- 浏览器直传 COS、Compass 附件元数据与分叉复制体系  
- 多 Agent 独立颁发 MCP Token  
- 改造 `yach-cli` 发图二进制协议（第一期仅 Markdown 插图）

## 3. 总体分工

```text
用户要模拟登录
  → load_skill → get_simulation_login_token(identifier)
  → Runtime MCP Client → cloudlearn-devtools (resolve → get_token)
  → 模型答复含 Token 文本（独立代码块）
  → 渠道后处理：QR ± COS → 回复附加二维码（失败则仅文本）
```

| 层 | 职责 |
|---|---|
| 上游 API MCP | `cloudlearn-devtools` 已有服务；`student.resolve` / `student.get_token` |
| Runtime 工具面 | 窄工具 `get_simulation_login_token` 挂入本轮 `toolsets` |
| Skill | 何时查、参数、空 Token、输出形态 |
| 渠道后处理 | QR / COS / 把图塞进 Web 或知音楼答复；**不是**模型工具 |

## 4. 查 Token（Agent 能力）

### 4.1 上游与配置

| 项 | 约定 |
|---|---|
| 入口 | Streamable HTTP MCP：`API_MCP_URL`（如 `…/devtools/mcp/api`） |
| 鉴权 | `Authorization: Bearer ${API_MCP_TOKEN}`，与 Java `devtools.api-mcp.token` 一致 |
| 启用 | URL 与 Token 均非空才挂载；缺一则本能力不出现在 toolsets |
| 请求 | 服务端调用；禁止带浏览器 `Origin` |

环境变量：`API_MCP_URL`、`API_MCP_TOKEN`（写入 `RuntimeConfig`）。

### 4.2 模型工具

- 名称：`get_simulation_login_token`  
- 入参：`{ identifier: string }` — 用户原始标识（学员编号或看起来像 uid 的数字），保持字符串与前导零  
- 内部：`api_query(student.resolve)` → 取顶层 `uid` → `api_query(student.get_token)`  
- 禁止：把原始 `identifier` 直接当 `uid` 调 `get_token`；禁止向模型暴露其它 `api_id`  
- 返回：

```ts
{
  status: 'ok' | 'not_found' | 'no_token' | 'invalid_request' | 'error';
  uid?: string,
  token?: string | null,
  message?: string,
}
```

- `status=ok` 且 `token` 为非空字符串：可展示与出图  
- `status=no_token`：学员已核实但当前无模拟登录 Token（`token=null`），不是调用失败  
- `status=not_found`：resolve 无记录

与 `lookup_learner`：本轮已有 uid 只作线索；本工具仍须在内部走 resolve（或等价核实），不得跳过。

### 4.3 挂载

在 `createRoundCapabilitySession` 增加 optional 能力（如 `simulation_login`）：配置齐全时注册 `get_simulation_login_token`，否则跳过。

### 4.4 Skill

- 建议名：`get-simulation-login-token`  
- `required_tools: [get_simulation_login_token]`  
- 触发：用户明确要模拟登录 / 学员登录 Token / 扫码登录凭据等  
- 缺标识时追问学员编号或 uid，不空查  
- 有 Token：答复中用**独立代码块**输出原值一次；说明二维码由系统附带，不声称已送达设备  
- 无 Token：明确「当前没有模拟登录 Token」，不假装已生成

## 5. 出图与 COS（渠道后处理）

### 5.1 放置与触发

- 代码：`runtime/src/capabilities/cos-store.ts`、`token-qr.ts`（或等价 `media/`）  
- **不**注册为模型 tool，**不**做上传 MCP  
- 触发：本轮成功工具结果中存在与 uid 配对的非空 `token` 后，出站前调用

### 5.2 流程

1. 将 Token 原文编码为 PNG 二维码（无登录 URL、不自动登录）
2. `put_object` 至私有桶
3. `get_presigned_url(Method=GET, SignHost=True, Expired=TTL)`
4. Web / 知音楼把签名 URL 附到答复

### 5.3 配置

| 变量 | 含义 |
|---|---|
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 子账号密钥，仅服务端 |
| `COS_REGION` | 桶地域 |
| `COS_BUCKET` | `BucketName-APPID` |
| `COS_PREFIX` | 对象前缀；默认/推荐 `troubleshoot-odyssey/test`，**不要**默认复用 `compass-agent/prod` |
| `COS_SIGNED_URL_TTL_SECONDS` | 60–3600，默认 900 |

四要素（ID/Key/Region/Bucket）缺一则关闭上传，仅文本 Token。可选 `IMAGE_*` 限制与 Compass 对齐，QR 体积远低于上限。

安全：签名 URL 不入库、不写应用日志；对象键含 owner（员工工号）隔离。

### 5.4 渠道行为

| 渠道 | 行为 |
|---|---|
| Web | 终态含 Token 代码块；有签名 URL 则展示二维码图 |
| 知音楼 | 在 Markdown 中附加 `![Token 二维码](signedUrl)`；沿用 `im send --markdown` |
| 降级 | COS/编码失败：保留 Token 文本，附加「二维码未能展示」类说明，不阻断答复 |

## 6. 验收

1.       破；】破婆婆婆婆哦；il；p09iujkl;']-0i9ujl;0987ythrfgdvxc’；来看，吗  
「“？怕；。¬  
】=-【‘怕；-0pp0-p0[[poikjhn[po8u7y6tre .;p0p;p;lp;lp'./'[-p0;'[p0;'[jkml,’怕；oliuytrefdsZX/
2. 未配 `API_MCP_*` 时工具不挂载，对应 Skill 不可用。
3. 有 Token 且 COS 可用 → 回复含二维码；COS 不可用 → 仅文本并说明缺口。
4. 模型工具列表中无上传/生图工具；进程中无新建 MCP server。
