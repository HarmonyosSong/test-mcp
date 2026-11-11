# 诊断案例复核与评估

> 本文只描述当前 Mastra TypeScript Runtime 的案例和评估入口。历史 Python 评估数字不再作为发布或质量依据。

## 1. 案例归档

终态消息会 best-effort 写入 `.data/knowledge-cases/`，诊断 outcome 追加到 `.data/knowledge-queries.jsonl`。归档失败不改变对话终态。案例可能包含用户输入、日志摘录和源码观测，应按内部诊断数据管理，不直接公开或提交。

在仓库根目录执行：

```bash
make knowledge-cases
npm --prefix runtime run cases -- capture --conversation CONV_ID --message MSG_ID
npm --prefix runtime run cases -- review CASE \
  --outcome confirmed \
  --root-cause '已核实的根因和理由' \
  --reviewer '复核人' \
  --evidence-id EV_ID
npm --prefix runtime run cases -- draft CASE --name canonical-entry-id --domain learning
```

- `confirmed` 必须关联报告中实际存在的源码/日志证据。
- 无法确认使用 `uncertain`，推翻候选使用 `rejected`；两者不能提炼为正向知识。
- 报告 verdict 是模型诊断状态，不等于人工复核结论。
- 优先复用 `CASE.proposal.similar_entries` 中的规范条目；新条目不得直接复制工单原文。

编辑案例同名 Markdown 草稿后：

```bash
npm --prefix runtime run cases -- apply CASE
make knowledge-validate

# 已通过正常评审直接补充条目时，只登记案例与知识的关联
npm --prefix runtime run cases -- link CASE --name canonical-entry-id
```

`apply` 会校验整个知识库、拒绝悬空引用/重复 ID/过期编辑，再原子写入规范位置。它不会自动把案例提升为 `official`/`code`，也不会伪造人工验证日期。知识维护规则见 [../knowledge/AGENTS.md](../knowledge/AGENTS.md) 和 [../knowledge/_schema.md](../knowledge/_schema.md)。

## 2. 固定集真实模型评估

```bash
make live-eval
```

评估使用当前配置的模型、Mastra `DiagnosisAgent` 和 request-scoped MCP 工具，逐轮原子写入 `.data/evals/latest.json`。模型未配置、轮次失败或声明断言不通过时命令返回非零；真实调用可能产生费用。

可用 `--input` 汇总或复核已有产物，用 `--baseline` 比较相同模型、数据集摘要和有序轮次。失败轮次仍计入分母，不能靠提前失败获得“成本下降”。

### 2.1 指标边界

- `correct_location`：固定源码夹具的文件定位断言。
- `expected_verdict_pass`：固定场景的结构化 verdict 断言。
- `appropriate_clarification`：固定区分问题关键词断言。
- `unsupported_conclusion`：必须人工审阅完整文本、报告和实际观测后填写；报告校验通过不能自动推出该值为 false。
- `model_requests`、token、耗时和工具计数只使用 Runtime 实际提供的数据；未知保持未知，不填零。
- 成本比较要求模型、数据集和轮次一致；单次随机样本不代表稳定质量或成本提升。

评估产物可能包含案例输入与输出，应保持本地、限制权限，不发布到外部分享材料。

## 3. 常规验证

```bash
make test-runtime
make test-mcp
make knowledge-validate
make lint
make build
```

涉及知识加载、检索或 MCP 时，还需运行：

```bash
uv run --project mcp_server pytest -q \
  mcp_server/tests/test_knowledge_base.py \
  mcp_server/tests/test_query_log.py
```

真实 LogCenter、Compass 或供应商联调必须单独记录环境、覆盖范围和未验证项；离线 mock 通过不等于生产权限、字段和诊断质量验收。
