# 容器数据根持久化规格

> 状态：已实现（待平台挂卷验收）  

> 日期：2026-11-11  
> 范围：Mastra TypeScript runtime（`runtime/`）可变状态落盘路径；容器部署与本地默认分离  
> 关联：配置见 [`README.md`](../README.md)；架构与 LibSQL 事实源见 [`ARCHITECTURE.md`](../docs/ARCHITECTURE.md)；对齐参考仓库 `dev-agent` 的 `AGENT_DATA_ROOT`  
> 硬约束：本地默认路径与行为不变；不自动搬迁已有数据；不改会话/诊断业务逻辑与 LibSQL schema

本文规定如何让容器重建后仍保留 `.data` 所代表的运行时状态：用统一数据根指向平台持久卷，做法对齐 `dev-agent`。

---

## 1. 背景与目标

### 1.1 问题

当前可变状态默认落在项目根下 `.data/`（容器内即 `/app/.data`）：

- LibSQL（`mastra/runtime.db`）
- Git mirror / workspace 快照
- 模型配置、知识查询日志、终态案例归档

Dockerfile 在镜像层 `mkdir .data/...`，生产 env 使用相对路径 `.data/...`。容器销毁重建时，可写层数据丢失；应用层「重启恢复」无法对抗卷未挂载。

### 1.2 目标

1. 新增统一数据根环境变量，派生现有全部 `.data` 子路径（对齐 `dev-agent` 的 `AGENT_DATA_ROOT`）。  
2. 本地未设置该变量时，行为与现网一致（仍为 `<项目根>/.data`）。  
3. 容器部署仅设置数据根为 `/data/troubleshoot-odyssey`，由平台将持久卷挂到该路径。  
4. 单项路径 env 仍可覆盖，且优先于数据根派生。  
5. **交付必须同步改仓库内 `Dockerfile` 与 `.env-prd`**（生产模板；镜像/`config/.env` 以该生产配置为准），不能只改 `config.ts`。

### 1.3 非目标

| 不做 | 说明 |
| --- | --- |
| 数据搬迁 / 自动迁移 | 不从旧 `/app/.data` 拷贝或改写历史；切卷后视为冷启动 |
| 改业务逻辑 | 不改 ProductStore、诊断编排、证据账本、SSO/Yach/LogCenter |
| 外部数据库 | 不把 LibSQL 换成远程库；仍单机文件 + 单副本 |
| 在 Dockerfile 内声明 VOLUME | 与 dev-agent 一致：挂卷由平台配置，镜像只消费绝对路径 |
| 改本地开发习惯 | 不强制本机使用 `/data/...` |

---

## 2. 对齐参考（dev-agent）

| 项 | dev-agent | 本项目 |
| --- | --- | --- |
| 统一根变量 | `AGENT_DATA_ROOT` | `HARMONY_AGENT_DATA_ROOT` |
| 本地默认 | 项目下 `var/` | 项目下 `.data/` |
| 容器示例路径 | `/data/xes-enterprise-agent` | `/data/troubleshoot-odyssey` |
| 配置注入 | `COPY config/agent.local.env`，进程读该文件 | 现有 `COPY config/.env ./.env`（或平台挂配置） |
| Dockerfile | 不声明 `VOLUME`；不把可变数据当真写入镜像层 | 同左；去掉镜像层 `.data` 作为数据真相 |
| 平台 | 持久卷挂到 `/data/...` | 同左，挂 `/data/troubleshoot-odyssey` |
| 单项覆盖 | `CONVERSATIONS_ROOT` 等优先于根 | 现有 `HARMONY_MASTRA_DATA_DIR` 等优先于根 |
| 迁移 | 改根不自动移动目录 | 同左；本规格明确不做搬迁 |

dev-agent 容器 Dockerfile 模式要点：`WORKDIR` + 依赖层 + `COPY` 应用与配置 + `ENV` 指向配置文件 + 启动脚本；**持久化不靠镜像内 mkdir 数据目录，而靠配置中的绝对数据根 + 平台挂卷**。

---

## 3. 配置合同

### 3.1 新增变量

| 变量 | 本地默认 | 容器部署 |
| --- | --- | --- |
| `HARMONY_AGENT_DATA_ROOT` | 未设置 → `<projectRoot>/.data` | `/data/troubleshoot-odyssey` |

相对路径相对于 `projectRoot` 解析；绝对路径原样使用（与现有 `path.resolve(projectRoot, path)` 语义一致）。

### 3.2 派生路径（未单项覆盖时）

```text
$HARMONY_AGENT_DATA_ROOT/
├── mastra/                  # 原 HARMONY_MASTRA_DATA_DIR；内含 runtime.db
├── git-mirrors/             # 原 HARMONY_MASTRA_GIT_MIRROR_DIR
├── workspaces/              # 原 HARMONY_MASTRA_SNAPSHOT_DIR / legacy snapshot
├── model-config.json        # 原 HARMONY_AGENT_MODEL_CONFIG_FILE
├── knowledge-queries.jsonl  # 原 HARMONY_AGENT_KNOWLEDGE_QUERY_LOG
└── knowledge-cases/         # 原 HARMONY_AGENT_KNOWLEDGE_CASES_DIR
```

`HARMONY_MASTRA_DATABASE_URL` 未设置时仍为 `file:<dataDir>/runtime.db`，其中 `dataDir` 为上述 `mastra/`。

### 3.3 单项覆盖优先级

与 dev-agent 相同：

1. 若设置了对应单项 env（如 `HARMONY_MASTRA_DATA_DIR`），使用该项（再经 `projectRoot` 解析）。  
2. 否则使用 `$HARMONY_AGENT_DATA_ROOT/<派生名>`。  
3. 若未设置数据根，数据根为 `<projectRoot>/.data`。

**容器部署必须删除下列相对路径单项**，否则会继续落到 `/app/.data`，挂卷无效：

- `HARMONY_MASTRA_DATA_DIR`
- `HARMONY_MASTRA_GIT_MIRROR_DIR`
- `HARMONY_MASTRA_SNAPSHOT_DIR`
- `HARMONY_AGENT_MODEL_CONFIG_FILE`
- `HARMONY_AGENT_KNOWLEDGE_QUERY_LOG`
- `HARMONY_AGENT_KNOWLEDGE_CASES_DIR`

本地 `.env.example`：增加 `HARMONY_AGENT_DATA_ROOT` 注释（默认省略）；原相对路径单项改为注释示例并注明「可省略，由数据根派生；一旦设置则优先于数据根」。README 配置表同步。

### 3.4 不进入数据根的内容

- 源码与构建产物：`runtime/`、`web/dist`、`mcp_server/`、`knowledge/`、`skills/`
- 进程配置：`.env` / 平台挂载的配置文件
- 只读允许根：`HARMONY_AGENT_ALLOWED_ROOTS`（仓库检视路径，不是会话库）

---

## 4. 部署合同

### 4.1 平台挂卷

- 挂载点（容器内）：`/data/troubleshoot-odyssey`
- 配置方式：与现网 `dev-agent` 一致，由发布平台配置持久卷；**不在本仓库 Dockerfile 内写 `VOLUME`**
- 拓扑：单副本（与现有 Yach 长连接、进程内会话串行一致）

### 4.2 `.env-prd`（生产配置模板，必改）

仓库文件：`.env-prd`（勿提交真实密钥到 git；本地/发布流水线据此生成镜像内 `.env` 或 `config/.env`）。

**必改内容：**

1. 增加：

```env
HARMONY_AGENT_DATA_ROOT=/data/troubleshoot-odyssey
```

2. **删除**（勿再写成相对 `.data/...`，否则挂卷无效）当前生产模板中的：

```env
HARMONY_MASTRA_DATA_DIR=.data/mastra
HARMONY_MASTRA_GIT_MIRROR_DIR=.data/git-mirrors
HARMONY_MASTRA_SNAPSHOT_DIR=.data/workspaces
HARMONY_AGENT_MODEL_CONFIG_FILE=.data/model-config.json
HARMONY_AGENT_KNOWLEDGE_QUERY_LOG=.data/knowledge-queries.jsonl
HARMONY_AGENT_KNOWLEDGE_CASES_DIR=.data/knowledge-cases
```

3. 其余 SSO / 模型 / Yach / LogCenter 等业务项保持不变。  
4. 文件头注释补充：容器依赖平台将持久卷挂到 `/data/troubleshoot-odyssey`；数据根由上项统一派生。

若发布流程是「`.env-prd` → 复制为运行 `.env` / `config/.env` 再 `COPY` 进镜像」，实现时须保证**打进镜像的那份**与上述生产模板一致，避免只改 `.env-prd`、镜像仍带旧相对路径。

### 4.3 `Dockerfile`（必改）

仓库文件：`Dockerfile`。对齐 dev-agent：「配置指到 `/data/...` + 平台挂卷」，镜像不把 `.data` 当持久真相。

**必改内容：**

1. 保留平台生成的 `FROM` 行，不改动该约定。  
2. **删除**当前将可变数据落在镜像层的做法，例如：

```dockerfile
&& mkdir -p .data/mastra .data/git-mirrors .data/workspaces .data/knowledge-cases \
```

3. 注释改为明确：运行时数据根为 `HARMONY_AGENT_DATA_ROOT`（生产 `/data/troubleshoot-odyssey`），须由平台挂持久卷；子目录由 runtime 启动时按配置创建（`0700` / 敏感文件 `0600`）。  
4. 继续 `COPY` 生产 env（现有 `COPY config/.env ./.env` 或等价路径）；**确保被 COPY 的 env 已含 §4.2 的数据根且无相对路径单项**。  
5. **不**在 Dockerfile 内写 `VOLUME`（与 dev-agent 一致，挂卷交给平台）。

### 4.4 数据搬迁

本规格**不考虑**从旧路径搬迁。首次启用挂卷后，旧容器可写层中的会话/配置不保留。

---

## 5. 实现影响范围

### 5.1 必改

| 位置 | 变更 |
| --- | --- |
| `runtime/src/config.ts` | 解析 `HARMONY_AGENT_DATA_ROOT`；派生 §3.2 路径 |
| **`.env-prd`** | **按 §4.2：写入数据根、删除 6 个相对路径单项、补充挂卷注释** |
| **`Dockerfile`** | **按 §4.3：去掉镜像层 `.data` mkdir；注释挂卷；COPY 的 env 与 `.env-prd` 合同一致** |
| `.env.example` | 文档化数据根；说明本地可省略、容器必设绝对路径 |
| 镜像内 / `config/.env` | 与更新后的 `.env-prd` 同步，禁止残留 `.data/...` 单项 |
| `README.md` | 配置表增加数据根；部署注意挂卷与单项清理 |
| `runtime/test/` | 新增配置单测：默认 `.data`、绝对根派生、单项覆盖优先 |

未同时更新 **`Dockerfile` + `.env-prd`** 不得视为本规格实现完成。

### 5.2 不动

- `ProductStore`、诊断/SSE、权限与渠道实现  
- LibSQL schema 与迁移命令语义（仅文件位置可变）  
- 本地 `make start` 默认路径习惯  

### 5.3 工作量与风险

- 应用侧：配置 + 测试 + 文档 + Dockerfile/env，预计小范围。  
- 阻塞：平台是否已将卷挂到 `/data/troubleshoot-odyssey`。  
- 风险：只改代码未挂卷 → 仍丢数据；保留相对路径单项 → 仍写 `/app/.data`。

---

## 6. 验收

| 场景 | 期望 |
| --- | --- |
| 本地不设 `HARMONY_AGENT_DATA_ROOT` | 数据仍在项目下 `.data/`，现有测试与手工路径不变 |
| 容器设根且平台挂卷 | 写入会话后销毁重建容器（同卷），会话与 `runtime.db` 仍在 |
| `.env-prd` 已更新 | 含 `HARMONY_AGENT_DATA_ROOT=/data/troubleshoot-odyssey`，且无 §3.3 相对路径单项 |
| `Dockerfile` 已更新 | 无镜像层 `.data` mkdir 作为数据落点；注释说明挂卷；COPY 的 env 与 `.env-prd` 一致 |
| 仅设根、仍留相对路径单项 | 视为配置错误；文档禁止；单测覆盖「单项优先」行为供运维理解 |
| 权限 | 数据根目录 owner-only 语义与现网一致（`0700` / `0600`） |

---

## 7. 实现顺序（待开工）

1. `config.ts` 数据根解析 + 单测  
2. **更新 `.env-prd`（§4.2）**  
3. **更新 `Dockerfile`（§4.3），并确认 COPY 进镜像的 env 与 `.env-prd` 一致**  
4. `.env.example` / README 合同说明  
5. 平台挂卷确认后做一次重建验收（§6）

本规格通过前不改业务代码以外的无关模块；实现阶段另开计划即可。  
**完成定义：** `config.ts` + **`.env-prd`** + **`Dockerfile`** + 文档/单测均已按上文落地；缺一不可。
