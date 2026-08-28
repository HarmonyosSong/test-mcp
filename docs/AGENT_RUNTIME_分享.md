# Agent Runtime 框架选型分享

> 结合咱们 HarmonyOS 诊断 Agent 项目的实践，回答三个问题：
> Runtime 是什么？主流框架差在哪？我们为什么选 pydantic-ai、它的天花板在哪？

---

## 一、先统一概念：Runtime 与 Harness

**Agent 的本质是一个循环：**

```text
接收输入 → 调模型 → 模型请求工具 → 执行工具 → 结果回喂 → 再调模型 → … → 输出答案
```

- **Runtime（运行时）**：让这个循环转起来的引擎。管消息历史、流式事件、重试、
  工具调用配对。类比 JVM——你写的 prompt 和工具定义是"代码"，runtime 是执行它的引擎。
- **Harness（驾驶舱）**：循环外面那层工程资产。权限审批、上下文压缩、断点恢复、
  沙箱、子代理编排。

一句话：**模型决定 Agent 聪不聪明，runtime/harness 决定它能不能干活、干得好不好。**

---

## 二、主流方案速览

| 框架 | 类别 | 状态模型 | 断点恢复 | 执行隔离 | 上下文管理 |
|---|---|---|---|---|---|
| **pydantic-ai** | 运行时库（Python） | 单次循环，无状态 | 无（自建） | 无 | 无（自建） |
| **Claude Code** | 闭源 Agent 产品 | 进程内会话 | 会话级 | 权限模式 deny-first | 自动压缩 |
| **Codex Harness** | 开源运行时（Rust） | 有状态 Session 容器 | Turn 级协议 | bwrap / 原生沙箱 | 内置 compaction |
| **DeepSeek Harness** | 开源运行时（TS） | append-only 事件溯源 | Agent Loop 可插拔 | 沙箱可插拔 | 插件化 |
| **pi agent / OpenCode** | 开源 CLI | 进程内会话 | 会话级 | 可选 | 极简 |
| **DeerFlow 2.0** | 多智能体框架 | 图状态机 + checkpoint | 步骤级断点续跑 | AIO 沙箱三级隔离 | 长短记忆系统 |

这些不是同一类东西：**pydantic-ai 是库**（自己盖楼）；**Codex / DeepSeek Harness 是
运行时基建**（楼的地基和管线）；**Claude Code / pi 是完整产品**（精装房）；
**DeerFlow 2.0 是多智能体系统**（小区）。选型先看自己要的是哪一层。

---

## 三、两个刚开源的 Runtime（2026 年 8 月）

这两个是本月同期开源的重磅基建，值得重点了解。

### Codex Harness —— OpenAI，8/19，Apache-2.0

> 引擎驱动 + 强契约协议。[github.com/openai/codex](https://github.com/openai/codex)

**四层架构：**

1. **Session 容器**：一次 Agent 运行的真正载体——对话历史、权限、沙箱、审批策略、
   取消信号都在这里，模型只是它的一个依赖。
2. **多层 Agent Loop**：工具并发调度、取消信号贯穿。
3. **App Server**：JSON-RPC over stdio 对外暴露，Thread / Turn / Item / Steer /
   Interrupt / Approval 都有正式协议语义；VS Code、JetBrains、Xcode 都通过它接入。
4. **沙箱与审批**：Linux bwrap、Windows 原生沙箱。

**三种接法**（集成深度递增）：`codex exec`（脚本/CI）→ Codex SDK（TS/Python）→
`codex app-server`（产品级嵌入）。

**一个说服力的数据**：ARC-AGI-3 基准上，同一模型仅靠 harness 配置
（retained reasoning + context compaction）得分 **13.3% → 38.3%**，输出 token 还少 6 倍。
harness 工程对表现的影响，与模型本身同一量级。

注意：IDE 扩展和 Codex Cloud 未开源。

### DeepSeek Harness（dsh）—— DeepSeek，8/13，MIT

> 微内核 + 一切皆插件。[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

**核心公式：模型（大脑）+ Harness（身体）= Agent。**

- 底座是 Cordis 插件框架（TypeScript / pnpm monorepo）。
- **一切皆插件**：模型适配器（40+ 家，含任意 OpenAI 兼容端点、本地 Ollama）、
  工具注册、会话日志、沙箱——甚至 Agent Loop 本身——都可替换。
- 四种预设模式：标准（完整编程 agent）/ PTC（模型写 TS 程序做多步执行）/
  极简（Bash + 编辑器）/ Creator（运行模型现场写的插件代码）。
- 可以把 Claude Code 和 Codex 当子代理调度。
- 一周 14 万 star，但官方标注 **Developer Preview**，有破坏性变更风险，不建议上生产。

### 两者对比

| 维度 | Codex Harness | DeepSeek Harness |
|---|---|---|
| 设计哲学 | 引擎驱动 + 强契约协议 | 微内核 + 一切皆插件 |
| 技术底座 | Rust | TypeScript + Cordis |
| 模型绑定 | 偏 OpenAI 生态 | 不绑定（40+ 家） |
| 可观测性 | 对话历史 + 线程事件协议 | append-only 事件溯源 |
| 生产就绪度 | 协议已产品化（IDE 在用） | Developer Preview |

---

## 四、CLI 侧的两种 Harness 哲学

- **Claude Code（复杂 harness）**：系统提示词上万 token、10+ 内置工具、deny-first
  权限、自动压缩。不信任模型，信任 harness 兜底。闭源，只跑 Claude。
- **pi agent（极简 harness）**：系统提示词约 200 token、4 个核心工具，押注前沿模型
  天生就会当 agent。开源（MIT）、模型无关（300+ 模型）、完全透明。

延伸阅读：[pi-vs-claude-code 对比矩阵](https://github.com/disler/pi-vs-claude-code/blob/main/COMPARISON.md)、
[When Minimal Beats Maximal](https://www.contextstudios.ai/blog/pi-agent-vs-claude-code-when-minimal-beats-maximal)。

### 附：DeerFlow 2.0

字节开源的多智能体框架（[bytedance/deer-flow](https://github.com/bytedance/deer-flow)，
50K+ star）：Lead Agent 总调度 + 中间件链 + 最多 3 个并行子代理
（Planner / Researcher / Coder / Reporter）+ LangGraph checkpoint 断点续跑 + 沙箱。
定位是跑几小时的"超级智能体"任务系统，不是聊天机器人。

---

## 五、咱们项目为什么选 pydantic-ai

项目定位：ToB 的 HarmonyOS 只读诊断服务（多轮聊天 + 四阶段诊断案例）。

1. **结构化输出是一等公民**：诊断报告的证据门禁（阳性结论必须关联证据 ID）落在
   Pydantic 模型上——模型编了也存不进去。CLI 产品做不到这个粒度。
2. **模型无关**：7 家 OpenAI 兼容供应商可切换。客户用 DeepSeek 还是 Kimi 是商务决定，
   不能被框架锁死。
3. **进程内嵌、数据可控**：Agent 循环跑在自己的 FastAPI 进程里，代码、API Key、
   对话都不出服务边界。CLI harness 嵌不进服务端产品。
4. **测试基建好**：TestModel / FunctionModel 离线断言事件流，全量测试不碰网络。

---

## 六、pydantic-ai 的天花板

它决定**单 Agent 循环**的质量上限，不解决编排层问题。

| 短板 | 说明 | 参照 |
|---|---|---|
| 无现成 harness | 上下文压缩、权限、断点恢复全自建 | Claude Code 是打磨多年的工程资产 |
| 无子代理编排 | 单代理循环 | DeerFlow 2.0 可派生并行子代理 |
| 无沙箱与执行 | 上限停在"诊断"，不能"修复" | Codex / DeerFlow 有沙箱 |
| 生态薄 | MCP 通，但没有插件市场 | Claude Code 有 hooks/skills 生态 |

**结论**：

- 做"只读诊断 + 可审计报告"的 ToB 服务 → pydantic-ai 是对的，劣势不在关键路径。
- 要做"自动修复 / 长任务代理" → 单代理循环不够，需自建编排层，或参考 DeerFlow 的
  Lead Agent + checkpoint 重构。
- 将来重建 harness 层时，先评估直接嵌 **Codex app-server**（协议已完整）或基于
  **dsh 插件体系**扩展，别从零写。

---

## 七、项目架构自评

**做得好的：**

- 分层干净、依赖单向：mcp_server（只读工具）→ agent（领域+编排）→ server（协议网关）
  → web（工作台），每层独立可测
- 契约驱动防幻觉：报告 Schema 带证据关联门禁
- 过程可审计：AG-UI 事件流 + 工具调用落盘 + Skill 显式加载可见，不暴露隐藏思维链
- 安全边界默认设计：只读、快照按 commit 隔离、路径防逃逸、API Key 不回显

**不足（按天花板从低到高）：**

1. 检索是纯字面搜索，无索引/语义检索——**诊断准确率最大瓶颈**
2. 存储是 JSON 文件 + 单进程锁——多用户不成立，上生产要换数据库
3. 无多租户与权限——当前是单机小组工具形态
4. 诊断是固定四阶段线性流——复杂问题吃力
5. 上下文管理粗糙——条数+字符截断，无摘要压缩
6. 可观测性薄——没有 tracing 与准确率评估闭环

**一句话：骨架（分层、契约、审计、安全）是生产级的；血肉（存储、检索、权限、
编排深度）是 MVP 级的。要扩规模，最先动数据库 + 检索索引。**

---

## 参考链接

**运行时与框架**
- [pydantic-ai 官方文档](https://ai.pydantic.dev/)
- [AG-UI 协议](https://docs.ag-ui.com/)
- [Codex Harness 架构深度解析：从 App Server 到 Agent Loop](https://grapecity.csdn.net/6a8bea73662f9a54cb9fe63b.html)
- [深入拆解 OpenAI Codex 与 DeepSeek 的 Harness 架构路线（51CTO）](https://www.51cto.com/article/853867.html)
- [DeepSeek Harness 开源解析：一切皆插件](https://www.aitoollab.cn/articles/deepseek-harness-agent-plugin-platform-2026/)

**CLI 哲学对比**
- [pi agent vs Claude Code 对比矩阵](https://github.com/disler/pi-vs-claude-code/blob/main/COMPARISON.md)
- [Pi Agent vs Claude Code: When Minimal Beats Maximal](https://www.contextstudios.ai/blog/pi-agent-vs-claude-code-when-minimal-beats-maximal)

**多智能体**
- [DeerFlow 2.0 架构解析（量子位）](https://www.qbitai.com/2026/03/391361.html)
- [DeerFlow 2.0 断点续跑机制](https://blog.csdn.net/Python_cocola/article/details/160933327)
