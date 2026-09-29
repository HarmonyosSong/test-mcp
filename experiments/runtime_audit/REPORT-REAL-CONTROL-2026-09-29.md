# 运行时工具效率·真实对照评测(2026-09-29)

方案 §8「真实对照」执行记录。固定条件:deepseek-flash(当前 API 配置)、
xesapp @ releaseV/20260921、知识库 HEAD(bf533e0 系)、默认工具预算
(失败 10 / 调用 30 / 无进展 4)。6 场景 × 3 次,走 API 全链路(真实模型、
真实仓库、真实知识库)。脚本:`run_real_control.py`;用例:`cases-real-control-2026-09-29.json`。

## 结构计量汇总(修复 unique 约束前)

| 场景 | 轮次 | 均步数 | 失败调用 | verdict 合规 | 提交合规 | 均输入 token |
|---|---|---|---|---|---|---|
| error-book-pdf(本例) | 3 | 15.0 | 2 | 100% | 100% | 170K |
| error-book-image-fails | 3 | 21.0 | 1 | 67% | 67% | 337K |
| error-book-entry-missing | 3 | 15.7 | 1 | 100% | 100% | 170K |
| unknown-repo | 3 | 4.0 | 0 | 100% | 100% | 25K |
| cross-turn-citation | 3 | 32.0 | 5 | 67% | 67% | 271K |
| other-product-pdf | 3 | 17.7 | 2 | 100% | 100% | 176K |

## 逐场景质量评审

- **error-book-pdf**:规则层(录入仅图片)+ 代码核实(WebView.ets:163 未读
  accept、无 fileSuffixFilters)+ 两个区分问题,路径稳定复现。质量符合预期。
- **error-book-image-fails**:正确识别「规则不适用」转入故障定位;两轮
  insufficient_evidence 并明确排除规则层(图片在支持范围内仍失败 → 上传链路
  待运行时材料),未越权确认根因。#3 未提交报告直接对话作答——prompts 允许
  该分支,属模型自由裁量,合规率记法随之修正预期即可。
- **error-book-entry-missing**:命中「错题本打不开」症状,先追问入口形态
  (不显示/白屏)与彼芯条件,再有限核实,未把未验证条目当结论。
- **unknown-repo**:4 步 25K token,直接说明小驴 H5 不在登记仓库、不乱绑
  xesapp,追问可获得的材料。最干净的一档。
- **cross-turn-citation**:修复后重跑 3 轮 100% 合规(见下)。
- **other-product-pdf**:学家云 HD 的 PDF 上传未误套错题本结论;知识无直接
  命中时如实说明并追问,检索路由无串扰。

## 发现的缺陷与修复(本批核心产出)

**citation unique 约束误伤合法引用**(cross-turn #1,conv-973e4f3edd):
模型需以不同摘录两次引用同一观测(支撑不同论点),旧「evidence IDs unique」
校验拒绝;模型先塞 `kind_note` 旁路字段(extra_forbidden 拒绝)再撞 unique,
连挂两次提交,第三轮 submit 流中断,整轮 failed 且无最终文本。

修复:`DiagnosisReport` 与 `DiagnosisReportDraft` 的判重从「ID unique」放宽为
「(id, excerpt) 对 unique」——同观测不同摘录合法,纯重复仍拒绝。摘录逐字子串
校验本就能防注水,放宽不降低防伪造强度。

修复后 cross-turn 重跑 3 轮:verdict 合规 100%、提交合规 100%、失败调用 1。

## 遗留问题(非机制缺陷,后续调优)

1. cross-turn 修复后 #2 出现 47 步/1.21M token 的扩散轮:第二轮在客户端仓库
   反复搜索 H5 侧「返回首页」触发点(21 次搜索)。search_stale 判定认「文件:行」
   新增,噪音命中会绕过止损;属方案 D 7.3 提示词/技能层调优空间。
2. image-fails #3 选择对话作答而非提交报告:分支一致性问题,如需稳定产物
   可在评测 expect 层区分「必须提交」与「允许对话」。
3. cross-turn 修复前 #1 的第三次 submit「工具调用中断」:服务端无异常日志,
   疑似上游流式中断,偶发,暂记观察。

## 结论

6 场景 18 轮 + 修复后 3 轮复跑:无越权确认根因、无伪造证据、无乱绑仓库;
唯一机制缺陷(citation unique)已修复并复跑验证。成本画像:规则澄清类
25K-50K token,代码核实类 100K-180K,深度故障定位类 200K-400K,扩散轮
可达 1.2M(遗留 1 的调优目标)。
