---
name: bind-harmony-repository
description: 当用户表达“绑定鸿蒙仓库”或类似意图时，从固定映射表找到对应仓库并向后端 /api/repositories 登记。
metadata:
  version: "0.1.0"
  stage: general
---

# Bind Harmony Repository

当用户想绑定 HarmonyOS 代码仓库时（例如说“绑定鸿蒙仓库”、“绑定 xesapp”、
“帮我登记一下鸿蒙主仓库”等），执行本流程。

## 绑定流程

1. **识别仓库**
   - 读取固定映射表 `skills/bind-harmony-repository/repos.json`。
   - 根据用户消息中的关键词匹配 `aliases` 字段；若用户直接给出仓库名（如 `xesapp`），
     也按 `name` 字段匹配。
   - 若用户未指定具体仓库，默认绑定 `xesapp`（学而思鸿蒙主仓库）。

2. **调用后端登记**
   - 使用 `Bash` 执行 `curl`，向本地 bug-reporter 后端发送 POST 请求：
     ```
     POST http://127.0.0.1:5887/harmonyos_agent/api/repositories
     Content-Type: application/json

     {"name":"<name>","url":"<url>"}
     ```
   - `name` 与 `url` 均来自映射表，必须保持原样，不可嵌入用户名/密码等凭据。

3. **处理结果**
   - HTTP 201：仓库登记成功，向用户展示仓库名与 URL。
   - HTTP 409：仓库已存在，提示用户仓库已登记，无需重复绑定。
   - 其他状态码或连接失败：如实展示后端返回的 `detail` 或错误信息，不要编造。

## 边界

- 只登记映射表中存在的仓库；不在表中的仓库先询问用户具体信息，不要猜测。
- 登记失败时不要把失败原因含糊带过，必须展示原始错误内容。
- 本 Skill 只负责仓库登记，登记成功后如需继续代码调查，再使用 `bind-harmony-workspace` 绑定快照。
