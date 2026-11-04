# 诊断反馈与评估入口

> **运行时边界（2026-11-04）**：固定集评测及案例 capture/review/draft/apply/link 命令均已切换到 Mastra TypeScript runtime。本文 2026-09 的评估数字和 Python 产物格式是历史记录，不代表当前 Mastra 结果。剩余验收见[迁移规格](mastra-runtime-migration-spec.md)，产品启动请看根目录 [`README.md`](../README.md)。

2026-09-24。覆盖仓库绑定、检索召回、症状覆盖、案例提炼和真实模型验证。

## 2026-09-24 行为记录

- 聊天不再拦截“绑定/登记”或伪造本地确认。原始消息正常发送到后端，模型调用 bind_repository
  才能更改当前会话的仓库、分支与 commit。全局登记仍由仓库设置完成；失败与未登记会如实返回。
- 保留短语匹配，新增可审查的概念同义扩展，覆盖错题本/错题集、优惠券/代金券等；未知概念仍可能漏召回。
  精确文本优先，概念匹配不提升知识可信度，不缩小跨域搜索范围。
- 现象从 3 条增加到 24 条，65 条事实全部挂接；每条新增入口都有区分问题。
  新增内容仅组织已有判据，authority=auto，无 verified_at，不能称为真实案例已验证。
- lookup_issue 的预览预算仍为 3 份、每份 1500 字符；首候选引用之外有余量时补充其他候选。
- 查询日志同时分析 lookup_issue 和 search_knowledge。新调用带会话/消息关联，诊断终态记录 verdict；
  人工根因复核保存在独立案例的 review 中，不将报告 verdict 当成人工确认。
- 模糊业务描述先使用区分问题，再查源码；输出未执行 DSML 协议的模型轮次标为失败。

## 案例复核与知识提炼

Mastra runtime 将终态案例 best-effort 保存到 `.data/knowledge-cases/`。以下命令在仓库根目录运行；
CASE 是该目录中的 JSON 文件名或完整路径。案例可能包含用户输入和诊断观测，应按内部诊断数据管理。

```bash
make knowledge-cases
npm --prefix runtime run cases -- capture --conversation CONV_ID --message MSG_ID
npm --prefix runtime run cases -- review CASE --outcome confirmed --root-cause '已核实的根因和理由' --reviewer '复核人' --evidence-id EV_ID
npm --prefix runtime run cases -- draft CASE --name canonical-entry-id --domain learning
```

确认要求已有报告中的源码/日志证据 ID。无法确认时用 uncertain，推翻候选用 rejected；两者不能提炼入库。
先查看 CASE.proposal.similar_entries，优先使用已有 name。已有条目草稿复制规范原文，保留原权威等级；
新条目生成 auto 模板，需编辑 description、aliases、适用范围、判据、例外和证据入口，不能直接复制个案原文。

```bash
# 编辑 CASE 同名 .md 后执行：校验整个知识库、拒绝悬空引用/重复 ID/过期编辑，再原子写入规范位置。
npm --prefix runtime run cases -- apply CASE
make knowledge-validate
# 若已经通过常规代码评审补充过条目，只登记回流关联：
npm --prefix runtime run cases -- link CASE --name canonical-entry-id
```

不会自动把确认案例提为 official/code，也不会自动刷新人工验证日期。新增事实须关联现象并补充区分问题。

## Mastra 评估

在仓库根目录运行：

```bash
make live-eval
```

命令通过 Mastra `DiagnosisAgent`、当前配置的模型和 request-scoped MCP 工具运行固定数据集；每轮结束即原子写入 `.data/evals/latest.json`。模型未配置、任何轮次失败或声明断言不通过时命令返回非零。可用 `--baseline` 比较同一模型、数据集摘要和有序轮次；`--input` 可汇总/复核已有产物。评测产物记录 runtime 提供的 `model_requests` 和耗时；模型调用前失败的请求数保持未知，聚合结果字符数仍未知。自由文本的 unsupported-conclusion 判断须人工审核，不从结构化报告推断。

## 历史 Python 评估产物

旧 Python 评估器源码和产物格式仅作为历史参考保留；它已不再是可运行的产品项目。不要将 Mastra 的 `.data/evals/latest.json` 交给旧格式处理。当前 provider-backed 评测使用 `make live-eval`。

以下指标和产物格式描述的是旧 Python 评测器：默认使用已配置模型；模型缺失、轮次失败、预期报告/定位/追问断言失败均返回非零。产物包含模型标识、数据集摘要、每轮状态、报告是否提交、Token、模型请求数、调用/复用/载荷/耗时，以及完整会话与案例旁文件。Mastra 当前评测指标以本节上方说明及迁移规格为准。

correct_location 是固定源码夹具的文件定位断言，appropriate_clarification 是固定区分问题关键词断言；
两者只适用于有对应判据的轮次。unsupported_conclusion 默认未知，需审阅完整文本及观测后在 rows 中
填 true/false，并记录复核依据；不能凭“报告校验通过”宣称自由文本无证据结论率为零。
汇总同时给出已评估/未评估分母。比较要求模型、数据集摘要、案例轮次一致；无基线不计算成本下降比例。

## 2026-09-24 历史执行结果

- 离线全量：238 passed、2 skipped（默认 opt-in 项）；真实模型另行显式执行。
- Web TypeScript/Vite 构建通过；知识校验通过，现象 24、事实 65、孤儿 0；保留 36 条既有“未经人工验证”告警，未修改核验日期。
- 真实模型 deepseek-flash，三场景四轮，最终版本全部完成：源码定位 1 次、区分追问 1 次，
  3 份报告经证据校验提交并存档。Token 输入 95,873、输出 13,937；15 次模型请求、15 次工具调用；
  工具载荷 19,524 字符，Agent 累计 76,482ms。小样本不代表线上总体正确率。
- 可提交的指标快照：[2026-09-24-repair.json](evaluations/2026-09-24-repair.json)。
- 原始产物：`.data/evals/repair-20260924-v2.json` 及同名前缀 conversations/cases。
- 初次真实运行保留在 `repair-20260924.json`：发现空工作区反复搜索和 DSML 文本问题；源码场景报告
  为 located，初版仅接受 probable 的判据过窄，修订为接受两个正向 verdict，同时要求命中真实文件位置。
  两版数据集/夹具存在变化，因此不据此声称成本下降。
- 旧 live 追问测试首次失败、再次通过，保留日志于本机 `/tmp/harmony-live-clarification*.log`；
  不能把单次通过当作模型稳定性保证。
