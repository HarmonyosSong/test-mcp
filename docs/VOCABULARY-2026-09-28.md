# 词表运营清单(第一轮,2026-09-28)

数据源:`.data/knowledge-queries.jsonl` 51 条记录(lookup_issue 23 + search_knowledge 12 +
diagnosis_outcome 15 + 其他),CLI 汇总出未命中 10 个问法、弱命中 5 个问法。
方法:15 个问法用当前生产检索重跑(9-24 修复版已自带 concepts 组),仍缺口的逐条对照
89 条知识定目标条目;建议的 alias 先内存 dry-run 验证(15 条真实查询 + 34 条冻结回归),
确认改善且无回归后才列入本清单。

## 一、建议补词(dry-run 已验证)

| 目标条目 | 补 alias | 覆盖的真实查询 |
|---|---|---|
| `cloudlearn-activity-unavailable`(symptom 云学习任务打不开) | 没有分数、无分数、空分数 | 「朗读完没有分数」「朗读评测 得分 未返回 空分数」「绘本 朗读 语音评测 回调 无分数」 |
| `classlearn-spoken-island-entry`(mapping 语音评测四链路) | evaluationCheckView | 「evaluationCheckView 朗读评测 分数(我的作品)」×2 |
| `h5-runtime-context-injection`(H5 靠原生注入判断自己在哪) | 浏览器正常、浏览器行为差异、H5 无法录音 | 「H5 网页在鸿蒙 Web 组件里打开功能失效,浏览器正常」「ArkWeb 与浏览器行为差异」「Web 组件 onPermissionRequest 麦克风录音权限 H5 无法录音」 |
| `app-search-scan-web`(symptom 搜索扫码或网页打开异常) | 白屏 | 「点击入口进入H5页面白屏」「WebView 打开白屏 加载失败 H5 页面」 |

取词原则:全部从查询原文抽取的短语(4 字左右),命中即 3.0 短语分;
不造词、不泛化(「分数」「H5」这类单词故意不收,避免跨条目碰撞)。

dry-run 结果(内存注入,未写文件):
- 真实查询 15 条:**9 条改善**(零命中/弱命中/误命中 → 3.0 精确命中目标条目),0 条变差。
  朗读族原本落在 mapping 条目(classlearn-spoken-island-entry,讲结构不讲故障),
  补词后正确落到 symptom 条目 cloudlearn-activity-unavailable。
- 冻结回归 34 条:regression 12/12、extra 6/6、pilot 3/10、negative 0/6 —— **全部不变**。

## 二、已解决,无需动作

9-24 修复版的 concepts 组已覆盖,重跑确认命中:

- 「组合加购」→ combo-addon-unavailable 2.7(concept:combo-addon)
- 「错题本进不去」→ error-book-unavailable / error-book-entry-picai-only 2.6(concept:error-book)

## 三、缺条目?——不建,崩溃类走代码检索(已确认)

「传入 profile={} 时页面崩溃」×2、「非空断言 运行时报错 Cannot read property of undefined」
是 ArkTS 运行时崩溃类,89 条知识里无对应条目。**结论:不建条目。** 架构分工本就如此:
业务规则(代码里读不到「为什么」)在知识库,崩溃定位(答案就在代码里)走仓库检索。
指引已就位(INVESTIGATION_ROUTING:「带明确堆栈、文件、符号或接口错误时直接查证据」;
CHAT 指引:bind_repository → search_project_text / read_project_file),仓库 MCP 五工具齐全。
真实会话 conv-c72aac3e3d(人文书房章节加载)里模型确实绑仓库做了只读定位,代码路径实际在用。

另经查证:这两条崩溃查询是 9-24 的手测(时间戳 08:06-08:10 密集连续,11 个真实会话
中无对应会话),并非真实用户求助。知识库保持业务规则定位,不为崩溃类扩界。

## 四、无动作

- 「App 有时候不对劲」×2 —— 泛化试探查询,无对应条目也不该有,保持零命中。

## 应用方式

第一节的 10 个 alias 改动小且已验证,直接改 4 个 md 文件的 frontmatter 即可,
不必走 knowledge_feedback 全流程(那是给真实会话案例提炼用的)。改完跑一次
`experiments/qmd/prepare.py` 重建 fixtures 之外无需其他动作——评测回归已随 dry-run 验证。
