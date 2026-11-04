# 错题上传修复后轮次评测：2026-09-30(下午)

**结论:本轮未提交的检索实现改动(引擎标识 `v2-transfer-context-1`)解决了 9 月 30 日上午报告指出的错题上传主要缺口——8 条上传问法的目标正文触达从 legacy 3/8、V2 0/8 提升到三种配置全部 8/8;标准 154 项与冻结 68 项行级零回归。V2 两项发布门槛仍未过,默认模式仍为 legacy。**

## 1. 本轮执行范围

- HEAD:`66371c2` 加当前未提交工作区。与[上午归档](results-current-2026-09-30.json)逐项核对:
  91 个知识条目、3 个数据集文件、3 个评测脚本摘要全部一致;**6 个检索源文件已变化**
  (concepts / preview_selection / retrieval_rules / retrieval_v2 / retriever / server),
  上午报告不再代表当前实现,故本轮全量复跑。
- 改动内容(按 diff 归纳):新增 FACET 概念类(弹窗、腾讯会议、地域降级为限定词);
  新增 transfer-in(上传/录入/导入)与 transfer-out(导出)动作概念;error-book 概念
  扩充「错题录入」「上传错题」;UNIT_FACETS 增加地域与 file_media(pdf/image);新增
  `transfer_context()`(同对象内任务/介质区分,不作召回锚点)与 `contexts_in()` 场景线索;
  V2 资格路径增加 C(无对象时共享场景+限定);预览槽位二改为直接事实与合格引用同口径竞争;
  术语匹配改为边界感知(Latin 词不再从标识符内部切出);快照标识纳入 response_policy。
- 复跑原 154 项、冻结 68 项、错题专项 16 项,共 **238 个测试项 × 3 配置 = 714 次查询**,
  另跑 75 次症状主描述探针。输出目录 `.data/kb-eval-20260930-pm/`,未覆盖历史归档。
- 样本为已有开发/合成回归集,不是独立真实用户准确率。本轮未运行真实模型诊断。

证据文件均为本次新产出，保存在未入库的 `.data/kb-eval-20260930-pm/`：
`legacy/results.json`、`legacy-ranked/results.json`、`v2/results.json`、
`paired/results.json` 和 `error-book.json`。这些本地产物未随仓库提交，当前无法从本报告直接打开。

## 2. 结构与内容维护

| 项目 | 结果 | 与上午相比 |
|---|---:|---|
| 知识总量 | 91(事实 66 / 现象 25) | 不变 |
| 无症状挂接的事实 | 0 | 不变 |
| 结构校验错误 / 告警 | 0 / 36 | 不变 |
| 填写人工验证日期的事实 | 33/66 | 不变 |
| 填写版本适用字段的事实 | 0/66 | 不变 |

知识内容本轮未被修改;上午指出的代码锚点混淆、旧规则适用范围、摘要/正文证据状态
不一致等条目级问题仍待处理。

## 3. 错题上传专项:主要缺口已闭合

| 8 条上传问法 | legacy | legacy + ranked | V2 |
|---|---:|---:|---:|
| 目标直达@3 | 1→**6** | 1→**6** | 0→**8** |
| 经候选引用可达 | 7→**8** | 7→**8** | 7→**8** |
| 实际返回目标正文 | 3→**8** | 3→**8** | 0→**8** |

- 上午零命中的「错题录入选了PDF,点完成后回到了应用首页」三种配置现在全部直达@3
  命中目标事实(legacy/legacy+ranked 目标在第 2 位,V2 同样进入前三)。
- 上午报告的示例「鸿蒙错题本能选到PDF,这代表业务允许录入PDF吗」:V2 下目标事实
  从第 4 位(0.55)升至第 2 位(0.8),与上传现象并列 top,正文进入预览。
- 直达@1:legacy 1→3、V2 0→4;上传现象仍常居首位,目标事实多居第 2——可接受,
  现象在前符合「先定位问题再给判据」的返回结构。
- 防退化对照:2 条入口正例三配置保持 2/2;4 条库外负例仍只有 negative-2
  (公司报销系统上传发票PDF失败)被误召回,与上午持平;2 条 ambiguous 探针行为不变
  (V2 保持 no_match,legacy 仍各返回 1 个候选)。
- 机制归因:概念扩充(错题录入/上传错题)、transfer_context 同分重排、预览槽位二
  竞争三者同时上线,本轮只验证合并效果,未做单因子消融。

## 4. 标准 154 项与冻结 68 项:零回归

- 154 项三配置的全部汇总指标与上午完全一致;**行级对比(hits 序列 + 预览名单)
  三配置均为 0 变化**。唯一差异是 V2 症状探针 `error-book-upload-fails` 用自身主描述
  查询时 top1 从 error-book-unavailable 变为自身,属改善。
- 冻结 68 项(paired):legacy 各组不变;V2 positive 组 direct1 14→15,
  direct3 保持 30/32;库外负例误召回 V2 保持 11/24,legacy 保持 14/24。
- paired 的 qualification_probes / preview_only_ablation / digest_probe 与归档一致。

**V2 发布门槛仍未过(与上午持平):**

| 门槛 | 要求 | 实际 |
|---|---:|---:|
| 16 个压力负例误召回 | ≤4 | 5 |
| 历史 10 个改写直接召回@3 | ≥3 | 2 |

事实自检锚点(legacy 49/66 直达@3、V2 43/66)不变——该差距来自锚点问法设计,
与本轮改动无关。

## 5. 验证

- `make knowledge-validate`:0 错误、36 告警(与上午相同)。
- `uv run --project mcp_server pytest -q mcp_server/tests`:**151 passed**
  (上午 129;新增 test_transfer_context.py 与 test_retrieval_boundaries.py 共 22 项,
  覆盖边界感知匹配、限定词资格、录入/导出区分、预览槽位竞争、快照摘要纳入新规则)。
- `uv run --project server pytest -q agent/evals/test_knowledge_retrieval.py`:**31 passed**。
- 延迟量级不变(challenge_positive p50:legacy ≈34ms、V2 ≈17ms;与上午差为机器负载,
  不作模式间比较)。快照标识已随规则与 response_policy 变化(`a4df2ae6…`→`ed5df8a5…`),
  日志可按版本归因。

## 6. 遗留问题(按优先级)

1. 库外负例 negative-2(公司报销发票 PDF 上传)三配置仍误召回——上传动作扩充后
   该面未收敛,需要「非本产品业务系统」的排除表达。
2. V2 压力负例 5/16 与历史改写 2/10 未过发布门槛;本轮改动不针对这两组。
3. legacy 对 2 条 ambiguous 探针仍返回候选(无状态标记),V2 已正确 no_match;
   默认模式仍是 legacy,`HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE` 未在 `.env` 显式设置。
4. 条目级旧问题(代码锚点混淆、verified_at 覆盖 33/66、版本字段 0/66)未动。

复现(新建目录,不覆盖本轮):

```sh
uv run --project server python experiments/knowledge_audit/run.py --mode legacy --out .data/kb-recheck/legacy
uv run --project server python experiments/knowledge_audit/run.py --mode legacy --preview-strategy ranked --out .data/kb-recheck/legacy-ranked
uv run --project server python experiments/knowledge_audit/run.py --mode v2 --out .data/kb-recheck/v2
uv run --project server python experiments/knowledge_audit/recheck_v2.py --include-ranked-preview --out .data/kb-recheck/paired
uv run --project server python experiments/knowledge_audit/check_error_book.py --out .data/kb-recheck/error-book.json
```
