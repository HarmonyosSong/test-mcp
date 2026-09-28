# bigram 检索移植对照实验(2026-09-24)

动机:在不用向量的前提下,验证 dev-knowledge 式确定性关键词检索(CJK bigram +
问句剥除 + 字段加权 + IDF 覆盖率)能否替代或补强现有子串检索。
方法:`bigram_index.py` 忠实移植 dev-knowledge retrieval.py/ranking.py 核心(字段映射
alias←recognition_term、title←topic.title、summary←topic.summary、name←topic.identity;
砍掉我们模型没有的 section/枚举/限定词/产品域维度),用 QMD 实验同一批 34 条冻结
查询(`.data/qmd-pilot/fixtures.json`,语料 sha256 一致)跑对照,两段式回退逻辑复刻
server.lookup_issue。

## 结果(recall;negative 为无关查询,应零命中)

| 模式 | regression(12) | extra(6) | pilot@3(10) | 负样本误放(6) |
|---|---|---|---|---|
| baseline 生产(子串≥4+concepts) | 12/12 | 6/6 | 3/10 | **0/6** |
| bigram(T=0~18 任意) | 12/12 | 6/6 | 5/10 | **4/6** |
| bigram+strict 闸门(T=0~18) | 12/12 | 6/6 | 4/10 | **3/6** |
| bigram+concepts 叠加 | 12/12 | 6/6 | 5/10 | **4/6** |
| strict @T=22~25 | 12/12 | 6/6 | 3~4/10 | 2/6 |
| (参照)QMD vector 分层规则 | 12/12 | 6/6 | 9/10 | 0/6 |

strict 闸门 = ①短语精确加成要求 posting ≥3 字(2 字词不得领 EXACT_BONUS)
②候选条目命中 token 的 idf 和 ≥4.0(distinctive 闸门)。bigram 查询 p50 0.11ms,
性能不是问题。

## 误放机制(负样本爆分拆解)

- 「登录失败」→ face-recognition-login-permission **69 分**:2 字「登录」被 alias
  包含,EXACT_BONUS(+24,可叠 cap 2)+ 多字段 token_score 叠加。
- 「手机发热耗电严重」→ login-registration-basics **68 分**:同上,「手机」。
- 「蓝牙耳机没有声音」→ cannot-sign-contract 20.8 分:单个泛化 bigram「没有」
  命中 title 即 ~18-21 分。

**召回增量与误放增量同源**:两者都来自 2 字粒度。收紧闸门时增量与误放同步消失,
不存在可用窗口。dev-knowledge 没这个问题,靠的是我们结构上没有的东西:按产品
域(business_line/product_id)隔离候选、recognition_term 是精心运营的产品叫法、
credible 判定还有 missing_literals/qualifier 等多重闸门。89 条单域语料里,2 字
碰撞概率太高,而子串≥4 的硬约束在无关查询间几乎不发生巧合——负样本 0 误放是
生产现状的真正价值,pilot 3/10 是它付的代价。

## 结论

1. **bigram 移植证伪,不进生产**。净收益为负(pilot +1~2 vs 误放 +2~4),且需要
   引入我们不具备的配套结构才能收敛。现有「子串≥4 + concepts」保留为检索主体。
2. **不用向量时,pilot 缺口的解法是词表运营,不是算法**。漏网的 pilot-1/2/5/8/9
   全死于零字面重合(「做错的题汇总复习」vs「错题本」、「板书存成文件」vs「课堂
   笔记」),任何关键词算法都救不了,只能让条目词表覆盖用户说法。杠杆在已有机制:
   querylog 未命中清单 → 人工补 alias;concepts 白名单按遗漏概念扩组;
   knowledge_feedback 闭环从真实会话提炼。
3. **评测纪律**:pilot_rewrite 的问法不进 aliases——它是唯一能量化「未知说法
   泛化能力」的回归集,词表运营的数据源应来自 querylog 真实未命中,不是评测集。
4. 若词表运营到瓶颈后仍需进一步增量,已验证的唯一路线是 QMD 报告的
   vector 分层规则(27/28 + 负样本 0/6),随时可重启。

复现:`mcp_server/.venv/bin/python experiments/bigram/run.py`,结果存
`.data/bigram-pilot/results.json`(全模式 top3、misses、分离度)。
