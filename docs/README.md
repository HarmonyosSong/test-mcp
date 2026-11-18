# 文档导航

本目录只保留当前架构、仍在使用的契约和继续有效的技术决策。阅读顺序如下；旧 Python Runtime 的实施记录、已完成的迁移清单和重复规划不再作为文档维护。

## 1. 当前系统

| 文档 | 用途 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前 Runtime 单 loop、能力会话、观测注册表、证据与存储的权威架构说明 |
| [orchestration-layer-design.md](orchestration-layer-design.md) | （已被 0004 去编排化取代，历史参考）旧调查计划、观察门禁、Agent Slot 与联合报告细则 |
| [business-knowledge-and-code-search-research.md](business-knowledge-and-code-search-research.md) | 业务知识与代码索引分层、三端开源检索方案比较，以及 Repository MCP 内部 CBM 适配边界 |
| [multi-platform-version-snapshot-design.md](multi-platform-version-snapshot-design.md) | 三端版本登记、commit 校验、GitLab archive 快照、组件物化与会话源码选择（已上线） |
| [../spec/compass-a2a-integration.md](../spec/compass-a2a-integration.md) | Compass A2A 传输、槽位、审批与真实联调边界 |
| [../spec/sso-login-design.md](../spec/sso-login-design.md) | 知音楼网页 SSO、local/server 模式和安全边界 |
| [../spec/yach-im-lightweight.md](../spec/yach-im-lightweight.md) | 知音楼 IM 渠道接入契约 |
| [diagrams/](diagrams/) | 当前架构图：01 诊断主流程（单 loop）、02 知识与证据架构 |

## 2. 运维与评估

| 文档 | 用途 |
| --- | --- |
| [mastra-migration-operations.md](mastra-migration-operations.md) | 旧 JSON 数据迁入 LibSQL 的 dry-run、apply 和回滚操作；不是 Runtime 迁移计划 |
| [triage-feedback-and-evaluation.md](triage-feedback-and-evaluation.md) | 当前案例复核、知识提炼和 `make live-eval` 入口 |
| [knowledge-retrieval-v2-design.md](knowledge-retrieval-v2-design.md) | 实验性非向量检索 V2 设计；默认仍为 `legacy`，是否启用以根 README 和配置为准 |
| [decisions/](decisions/) | 仍然有效的 ADR；文中旧路径属于决策形成时的历史上下文 |

## 3. 当前最容易混淆的边界

- 诊断链路为**单 loop 去编排化**（0004）：无 Supervisor、阶段状态机、外发审批与联合报告；协查是模型可见的 `consult_compass` 工具，完成态结论登记为 `kind=external` 正式观测，与本地观测同级。
- 远程日志由独立 `log-mcp` 提供，Runtime 每轮经 HTTP 挂入工具会话（连不上则本轮降级）；学员身份由 Runtime 私有注入，不进模型 schema。
- 最终回答首行固定为「判定：」锚点（校验器、知音楼标签、eval 共用）；知音楼 IM 输出固定模板（加粗归属指引 + 分点原因 + 动态补充信息），Web 工作台保留完整结论与依据。
- 版本快照链路：version-registry 登记 + GitLab archive 物化 + 组件自动解析（iOS 按 Podfile.lock、安卓按 settings.gradle 钉版本与 per-module tag，同 commit 只物化一份）；轮内热绑定，对照端经 `target=compare` 双槽位共存。
- code_index 目录（96 条目，含角色/关键符号/数据流注解）与 CBM 代码图只作导航线索，必须回读同一快照源码才形成证据。
- 2026-11-13 起全链路明文（内网协作排查决定）：学员编号/电话/凭证在工具结果、事件与归档中不脱敏；Compass 外发摘要只含用户原文与协查问题。
