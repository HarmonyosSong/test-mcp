# yach-mcp 接入指南

> 面向:要把知音楼能力接进自己 Agent 的工程师。
>    本仓库是知音楼开放平台的 MCP server 集,通过标准 MCP 协议(stdio)对任意 Agent 框架暴露 54 个工具。本文讲怎么把它接进你的 Agent。 
## 前置条件

|项|要求|说明|
|:----|:----|:----|
|Node.js|≥ 22.13.0|package.json 的 engines 限定,低了跑不起来|
|数字伙伴凭证|YACH_APP_KEY / YACH_APP_SECRET|在知音楼数字伙伴管理后台申请,**每个团队/应用一对**|
|平台 scope|按需|见下文「权限申请」,不开对应 scope 工具会报「应用未授权」|

## 第一步:拿到代码并装依赖

```bash
git clone https://git.100tal.com/peiyou_app_ai/digital_partner.git -b yach-mcp
cd digital_partner
npm install
```
> 本仓库即 `yach-mcp` 分支的 checkout。 
## 第二步:配凭证

凭证走**环境变量**,不落任何密钥文件。两种给法:

**方式 A ——**`.env`**文件(本地开发推荐)**

```bash
cp .env.example .env
# 编辑 .env,填入:
#   YACH_APP_KEY=xxx
#   YACH_APP_SECRET=xxx
```
`.env` 已加入 `.gitignore`,不会被提交。
**方式 B —— 直接在宿主配置里注入**`env`**(分发/生产推荐)**

见下面各框架的配置示例。

⚠️ **常见坑**:部分宿主(如某些 Agent 框架)会**过滤掉名字含**`KEY`**/**`SECRET`**/**`TOKEN`**的继承环境变量**,导致 server 启动报「缺少 YACH_APP_KEY」。必须在宿主配置的 `env` 字段里**显式声明**,不能只依赖 shell 环境变量。

## 第三步:选要挂哪些 server

**不要直接挂全量 server**——54 个工具的 schema 会进每一次模型请求,白白消耗大量 token。按你的 Agent 需要的能力,挑 1~3 个子 server 挂:

|你要 Agent 能…|挂这个 server|工具数|
|:----|:----|:----|
|发私聊/群消息、读群历史、撤回|yach-im|8|
|读写知音楼文档、管理协作者、导入导出|yach-doc|14|
|检索/读取知识库、导入导出、管协作者|yach-lore|11|
|工号 ↔ 用户 ID 互查|yach-contact|1|
|建群/管成员、话题群发帖|yach-group|11|
|查节假日|yach-schedule|1|
|定时发消息/回调|yach-cron|8|

完整能力清单见 README。

## 第四步:按你的 Agent 框架接入

### Claude Code

```bash
# 每个要挂的 server 执行一条;以 im + doc 为例
claude mcp add yach-im -- node --import tsx /绝对路径/digital_partner/src/yach/mcp/im-server.ts
claude mcp add yach-doc -- node --import tsx /绝对路径/digital_partner/src/yach/mcp/doc-server.ts
```
环境变量走你 shell 的 `.env` 或系统环境(Claude Code 不 scrub)。
### 通用 MCP 宿主(JSON 配置)

绝大多数支持 MCP 的框架(自研 Agent、各类桌面客户端)都接受这种配置:

```json
{
  "mcpServers": {
    "yach-im": {
      "command": "node",
      "args": ["--import", "tsx", "/绝对路径/digital_partner/src/yach/mcp/im-server.ts"],
      "cwd": "/绝对路径/digital_partner",
      "env": {
        "YACH_APP_KEY": "你的 appkey",
        "YACH_APP_SECRET": "你的 appsecret"
      }
    }
  }
}
```
多挂就在 `mcpServers` 里加条目,`args` 最后一项换成对应 server 的入口文件(`doc-server.ts` / `lore-server.ts` / `group-server.ts` / `cron-server.ts` / `contact-server.ts` / `schedule-server.ts`)。
### dsh

在 profile 的 `cordis.patch.yml` 中加(每个 server 一条):

```yaml
- insert:
    - id: mcp-yach-im
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: yachim
        transport: stdio
        command: node
        args: ['--import', 'tsx', '/绝对路径/digital_partner/src/yach/mcp/im-server.ts']
        cwd: /绝对路径/digital_partner
        env:
          YACH_APP_KEY: !!js process.env.YACH_APP_KEY
          YACH_APP_SECRET: !!js process.env.YACH_APP_SECRET
```
## 第五步:验证接上了

随便起一个 server,它应该打印启动日志并挂起等待 stdio:

```bash
npm run mcp:im
# 输出:[yach-mcp] yach-im 已启动(stdio)   ← 卡在这属正常,Ctrl+C 退出
```
再在 Agent 里让它调用一个工具,比如「查一下数字伙伴在哪些群里」(触发 `yach_robot_groups`)。能返回结果即接入成功。
## 权限申请(不申请会报「应用未授权」)

工具能不能调通,取决于数字伙伴后台给应用开了哪些 scope。按需申请:

|能力|需要的 scope(示例)|
|:----|:----|
|发消息|im:message:v1:send、im:group:robot:send|
|读群历史|im:group:msg:list|
|消息撤回|msg:v2:recall|
|文档读写|doc:content:get、doc:file:create、doc:content:append|
|群管理|im:group:create、im:group_user:add、im:group_member:list|
|知识库|doc:lore_node:list、lore:collaborator:add 等|

完整 scope 清单见官方 [权限 Scope 表](https://yach-open.zhiyinlou.com/api/reference/scopes.html)。

## 让 Agent「听见」用户说话(可选)

本仓库只负责 Agent **主动调用**接口(出方向)。如果要让 Agent 在用户 @ 机器人时被**触发**(入方向),需要另外接消息推送,两选一:

* **yach-cli 长连接**:装官方 [yach-cli](https://yach-open.zhiyinlou.com/cli/),`yach-cli event` 接收下行消息(NDJSON 流)

收到消息后唤起你的 Agent,Agent 再通过本仓库的 MCP 工具干活。

## 常见问题

**Q:启动报「缺少 YACH_APP_KEY」?**

 A:宿主把你 shell 里的环境变量过滤了。在宿主配置的 `env` 字段里显式写上,见「第二步」的坑。

**Q:调工具报「应用未授权 / code 170013」?**

 A:数字伙伴后台没开对应 scope,见「权限申请」。

**Q:群历史**`yach_group_history`**返回空?**

 A:平台限制只能取最近 24h、100 条;且对新群可能返回空,是平台行为。

**Q:能不能一个进程挂全部工具?**

 A:能(`npm run mcp`),但不推荐——54 个 schema 进每次请求很费 token。按需挂子 server。


---


