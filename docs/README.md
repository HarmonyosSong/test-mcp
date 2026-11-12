# 文档导航

本目录只保留当前架构、仍在使用的契约和继续有效的技术决策。阅读顺序如下；旧 Python Runtime 的实施记录、已完成的迁移清单和重复规划不再作为文档维护。

## 1. 当前系统

| 文档 | 用途 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前 Runtime、Supervisor、能力会话、证据与存储的权威架构说明 |
| [orchestration-layer-design.md](orchestration-layer-design.md) | 已实现的调查计划、客户端观察门禁、Agent Slot、审批恢复、并发和联合报告细则 |
| [multi-capability-expansion-plan.md](multi-capability-expansion-plan.md) | 尚未完成的能力及实施顺序；不是现有功能清单 |
| [business-knowledge-and-code-search-research.md](business-knowledge-and-code-search-research.md) | 业务知识与代码索引分层、三端开源检索方案比较，以及 Repository MCP 内部 CBM 适配边界 |
| [multi-platform-version-snapshot-design.md](multi-platform-version-snapshot-design.md) | 三端版本登记、commit 校验、GitLab archive 快照和会话源码选择 |
| [../spec/compass-a2a-integration.md](../spec/compass-a2a-integration.md) | Compass A2A 传输、槽位、审批与真实联调边界 |
| [../spec/log-catalog-query-capability.md](../spec/log-catalog-query-capability.md) | 当前 Catalog/SLS 四工具、私有身份、脱敏入账契约及真实验证边界 |
| [../spec/sso-login-design.md](../spec/sso-login-design.md) | 知音楼网页 SSO、local/server 模式和安全边界 |
| [../spec/yach-im-lightweight.md](../spec/yach-im-lightweight.md) | 知音楼 IM 渠道接入契约 |

## 2. 运维与评估

| 文档 | 用途 |
| --- | --- |
| [mastra-migration-operations.md](mastra-migration-operations.md) | 旧 JSON 数据迁入 LibSQL 的 dry-run、apply 和回滚操作；不是 Runtime 迁移计划 |
| [triage-feedback-and-evaluation.md](triage-feedback-and-evaluation.md) | 当前案例复核、知识提炼和 `make live-eval` 入口 |
| [knowledge-retrieval-v2-design.md](knowledge-retrieval-v2-design.md) | 实验性非向量检索 V2 设计；默认仍为 `legacy`，是否启用以根 README 和配置为准 |
| [decisions/](decisions/) | 仍然有效的 ADR；文中旧路径属于决策形成时的历史上下文 |

## 3. 分享材料

- [architecture-sharing.html](architecture-sharing.html)：可直接打开的分享页面。
- [LEADERSHIP_SHARE.md](LEADERSHIP_SHARE.md)：同主题的 Markdown 讲解稿。
- [diagrams/](diagrams/)：分享页引用的架构图。

分享材料用于讲解设计，不替代上述当前契约。图中“当前”“规划”标识应与 [ARCHITECTURE.md](ARCHITECTURE.md) 的能力状态一致。

## 4. 当前最容易混淆的边界

- Supervisor、Compass Slot、外发审批、自动跨侧和联合报告**已接入聊天链路**。
- LogCenter 四工具的私有身份发现、目标绑定、脱敏和关联入账框架已实现；真实生产字段、权限、索引兼容性和真实学员联调尚未验收。
- 新工单命中服务端关键词不等于立即调用 Compass；没有本地 `kind=log` 观测时先执行客户端观察。
- 创建会话后的精确版本快照链路已接入；版本登记表支持 shell + component/config 多仓组合挂载，源码观测会携带实际仓库、commit 和仓库内 path。Web 不要求预选端、版本或仓库，Runtime 先从当前提示词解析范围，再使用已确认的 LogCenter 事实在当前或后续轮次完成绑定；正在运行轮次不热切换，生产登记数据仍需逐端核对。
- 代码图索引现在作为 Repository MCP 的可选内部后端提供只读导航；图命中永远不能直接成为故障证据，仍须回读同一快照源码。
