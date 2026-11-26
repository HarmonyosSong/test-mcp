---
name: get-simulation-login-token
description: 用户明确要求模拟登录、学员登录 Token 或扫码登录凭据时使用。调用 get_simulation_login_token 查询 Token；不用于普通排障或仅查档案/设备。
metadata:
  version: "0.1.0"
  stage: intake
  modes: [chat]
  required_tools: [get_simulation_login_token]
---

# 学员模拟登录 Token

## 何时使用

仅当用户**明确**要：模拟登录、学员登录 Token、扫码登录凭据、登录二维码（指 Token 码）等。

不要在普通故障排查、仅查学员档案/设备时调用。取人仍用 `lookup-learner-profile`。

## 流程

1. 缺学员编号且缺 uid：追问补充，不空查。
2. 调用 `get_simulation_login_token({ identifier })`，传入用户原始标识（保持字符串与前导零）。  
   工具内部会核实身份再查 Token；不要把 identifier 自行当成 uid 拼参数。
3. 本轮若已通过 `lookup_learner` 得到 uid，仍把**用户原始标识或已核实 uid**传给本工具即可；以工具返回为准。
4. 解读返回：
   - `status=ok` 且 `token` 非空：可展示
   - `status=no_token`：学员存在但当前没有模拟登录 Token，如实说明，不假装已生成
   - `status=not_found`：请用户核实标识
   - `status=error`：说明失败原因与缺口

## 输出

- 有 Token：用**独立代码块**输出 Token 原值一次；可注明 uid。说明二维码由系统在渠道侧附带，不声称已推到用户手机或已完成登录。
- 最终回答使用 `判定：信息查询`（本任务不是故障定位）。
- 无 Token / 未查到：同样用 `判定：信息查询`，写清结果，不要编造 Token。

```text
判定：信息查询

【模拟登录 Token】
UID：…
（下方代码块为 Token 原值）
```

不要加载排查类 Skill 来「顺便」查 Token；本技能与排障主路径分离。
