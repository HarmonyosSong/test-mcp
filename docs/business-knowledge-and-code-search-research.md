# 业务知识与三端代码检索：调研及建议

> 调研日期：2026-11-11。范围：HarmonyOS、iOS、Android 共用的客户端排查助手。已完成 codebase-memory-mcp 0.12.1 的单个 HarmonyOS 工程探索性 PoC，并已封装进 Repository MCP 的首版只读导航面；三端精度及生产验收仍待完成，不替代当前知识 Schema 和 Runtime 契约。

首版采用 **现有文本搜索打底，`codebase-memory-mcp` 补代码导航**。当前已将其封装进 Repository MCP，提供可选的符号、文件 outline 和调用候选工具；它仍不能替代源码回读。`ripgrep` 是后续性能优化候选，尚未替换现有扫描。`ast-grep`/`zvecgrep` 目前不能直接识别 `.ets`；多仓库共享搜索需求扩大后，再评估 Zoekt 或 Sourcebot；不同时引入多套未验收的语义索引。

## 1. 产品边界

客户端只有一个 Agent，HarmonyOS、iOS、Android 是调查上下文和语言适配维度。服务端 Agent 继续通过 Supervisor 和 A2A Slot 协查，不因接入代码索引而复制客户端 Agent。

业务知识库回答“正常业务应该怎么运行”，例如组合加购的资格、可用商品、有效时间、互斥条件，以及区分这些条件需要询问什么。代码索引回答“当前端、当前版本的实现在哪里、谁调用它”。两者独立更新：

| 层 | 维护内容 | 不能据此声称 |
| --- | --- | --- |
| 业务知识 | 规则、术语、对象/动作/状态、例外、适用范围、来源和核验状态 | 本次故障根因成立；某个文件仍是当前实现 |
| 业务关系 | 现象关联规则、规则之间的前置/互斥关系；保留稳定 ID 与跨域引用 | 已建立真实代码调用关系 |
| 代码索引 | 从指定源码快照提取文件、符号、引用、调用及依赖关系 | 这些静态路径本次实际执行；图中没有边就没有调用 |
| 源码与日志观测 | 当前调查实际读取的原文、来源、范围和快照身份 | 单凭代码条件就证明现场满足该条件 |

业务库不再以维护文件路径、行号和易变函数名为目标；业务术语和有来源的协议术语仍可帮助构造搜索，不把它们当成代码位置的权威。历史代码核验出处不能在迁移时丢失或凭空升级为三端通用事实。

## 2. 问题进入后的路径

1. 先区分规则咨询与故障调查。业务描述优先查知识；已提供堆栈、接口名、错误码时可以直接使用技术线索，不强制做一次没有价值的知识查询。
2. 规则来源可靠且端、版本、前置条件明确时，解释规则和正确操作即可。知识命中本身不能把一次故障判成“正常行为”；不确定或来源冲突时继续澄清。
3. 需要调查时，复用当前 `observe → source` 约束，确认现场平台、版本和必要关联信息。索引接入不能绕过观察门禁或自动换绑源码。
4. 将业务对象、动作、状态、页面文案和已观察到的技术标识转成有界代码检索。已确认的平台用于选择源码快照；知识中的端和业务域仍只影响排序，保留跨端/跨域线索与全局回退。
5. 文本/符号检索缩小范围，必要时查询引用和调用关系，再回读同一快照的实际源码。图节点、相似度分数和关系摘要只作导航。
6. 将实际观测交给现有 EvidenceLedger 和报告校验。出现明确服务端线索时沿用 Supervisor、外发审批和 A2A 协查流程。

例如“组合加购按钮不能点”，业务库先提供需要核实的资格和状态，而不是给出某个 `.ets` 文件。Agent 结合当前端的页面文案、接口和错误标识定位实现，再检查按钮条件与实际日志。若规则未命中，继续有范围的源码/日志调查，不能把知识覆盖不足当成问题不存在。

## 3. GitHub 方案比较

以下支持情况主要来自项目文档和部分源码核对；codebase-memory-mcp 的 HarmonyOS 实测另见 §5。尚未完成三端性能或准确率基准。

| 方案 | 解决的问题 | 三端覆盖与限制 | 对本项目的建议 |
| --- | --- | --- | --- |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | 无需预建索引的快速文本/正则搜索 | 直接搜索三端文本；不提供符号绑定、定义/引用解析 | 保留为基线与兜底；先于自建索引做性能比较 |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 现成 MCP，持久化代码图、符号/全文搜索、调用路径与增量更新 | 明确包含 ArkTS、Swift、Objective-C、Java、Kotlin grammar；各语言调用解析能力不同 | 第一优先 PoC；由项目适配器绑定快照、裁剪工具和限制输出 |
| [Zoekt](https://github.com/sourcegraph/zoekt) | trigram 索引、多仓库字符串/正则检索和查询 API | 文本检索适用于三端，不等于完整语义调用图 | 代码规模/并发证明需要常驻全文索引后引入；接现有 MCP 需适配 |
| [Sourcebot](https://github.com/sourcebot-dev/sourcebot) | 自托管多仓库搜索平台，现成 MCP、GitLab 等代码源接入 | 可做跨仓库文本检索；定义/引用能力需按语言和索引配置另验收 | 需要团队共享索引和仓库权限同步时评估；当前不必替换现有工作台 |
| [CocoIndex Code](https://github.com/cocoindex-io/cocoindex-code) | AST 切块、增量向量索引、自然语言代码搜索、MCP | 当前语言表列出 Swift、Java、Kotlin，未列 ArkTS、Objective-C；后两者需要额外适配和验证 | 作为自然语言检索对照，不作为首版三端统一主索引 |
| [Code Index MCP](https://github.com/johnhuang316/code-index-mcp) | 现成文件/符号索引与文本搜索封装 | Java、Kotlin、Objective-C 有专用 Tree-sitter 策略；Swift 为基础文件索引 fallback，未明确列出 ArkTS | 可以对照接入成本，但不能把“支持文件”当成三端 AST 能力齐备 |
| [ast-grep](https://github.com/ast-grep/ast-grep) | 基于 AST 的结构模式搜索 | 内置语言表包含 Java、Kotlin、Swift；ArkTS 等需自定义语言能力 | 按模式搜索需求补充；本身不替代持久化索引和语义引用解析 |
| [zvecgrep](https://github.com/zvec-ai/zvec-grep) | 本地优先的 ripgrep、BM25 和向量混合检索 | 0.3.0 文件类型表没有 `.ets`，本地 embedding 还依赖模型下载或预置缓存 | 作为语义兜底候选；先完成 ArkTS 文件适配和离线模型供应，再评估中文召回 |

### 3.1 为什么优先验证 codebase-memory-mcp

它与当前产品的衔接较直接：已有 MCP、SQLite 持久化、代码关系查询和增量维护，且确实包含 `.ets` 的 ArkTS 检测与专用 grammar，不需要从零组合一个索引服务。

但必须保留以下边界：

- [grammar 清单](https://github.com/DeusData/codebase-memory-mcp/blob/main/internal/cbm/vendored/grammars/MANIFEST.md) 表明 ArkTS 是项目维护的 TypeScript 派生 grammar，加入了 ArkUI 语法；不是华为官方语义索引。README 将 ArkTS 列为尚未基准测试的语言。
- README 的“Hybrid LSP”是项目内置的类型解析实现，不是调用真实 SourceKit、JDT 或 DevEco 语言服务器。当前增强解析清单包含 Java/Kotlin，不包含 Swift、Objective-C、ArkTS；不能据此承诺三端都有 IDE 级引用精度。
- [语言检测源码](https://github.com/DeusData/codebase-memory-mcp/blob/main/src/discover/language.c) 对 `.m` 进行内容判别，默认 `.h` 为 C++，当前默认扩展名表未发现 `.mm`。iOS 的头文件和 Objective-C++ 必须专门验收；简单映射扩展名不等于正确解析混合语言。
- 索引新鲜度、同名符号歧义、未解析关系及语言覆盖必须显式返回。项目自己的准确率和 Token 节省数字不作为本产品的验收结果。
- 当前实现有账号级共享 daemon/cache 协调，不能假定“每轮新建 MCP 进程”就得到独立索引或租户隔离。PoC 要验证固定快照命名、并发查询、取消与生命周期；产品侧只挂载已批准的只读工具。

### 3.2 自然语言搜索与精确检索各有用途

用户说“组合加购为什么不能买”，源码可能使用完全不同的标识。业务术语扩展、符号索引和语义搜索都可能帮助召回，但解决层次不同：

- 已知错误码、接口路径、日志字符串：先文本精确检索。
- 已知类/函数/协议：先符号和定义/引用检索。
- 只有业务描述且术语扩展无结果：比较自然语言语义召回。
- 已定位入口，需要跨文件理解：查询调用/依赖后回读源码。

CocoIndex Code 提供本地或服务端 embedding 配置；默认语言覆盖不足以直接统一三端。若进入对照实验，需要单独检验中文业务问句、模型选择、首建成本和增量成本，不能只看演示中的英文查询。

### 3.3 需要更高精度时的语言适配

| 代码范围 | 后续可评估能力 | 部署约束 |
| --- | --- | --- |
| HarmonyOS ArkTS/ArkUI | ArkTS grammar 与 DevEco 能力验证；文本搜索兜底 | TypeScript grammar 不能直接等同于完整 ArkUI 支持，重点测装饰器、`struct`、UI DSL 和跨模块调用 |
| iOS Swift | [SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp) | 依赖工具链、项目构建与模块索引；涉及 Apple SDK 的精确分析通常需 macOS/Xcode，不能假设 Linux Docker 完整覆盖 |
| Objective-C/Objective-C++ | [clangd](https://clangd.llvm.org/design/compile-commands) 与 SourceKit 相关能力 | 需要正确的编译参数、头文件与 SDK；混编、动态消息和 swizzling 存在静态分析边界 |
| Android Java/Kotlin | [SCIP Java/Kotlin](https://github.com/scip-code/scip-java)、[官方 Kotlin LSP](https://github.com/Kotlin/kotlin-lsp) | SCIP 需要配合构建产物/编译配置；Kotlin LSP 当前标 Alpha，Android Gradle Plugin 支持仍标实验性 |
| 跨语言索引交换 | [SCIP 协议](https://github.com/scip-code/scip) | 是索引格式和导航协议，不是开箱即用的搜索服务；需要索引器与查询层 |

这些能力适合按已确认的精度缺口补充。若需要构建/语言服务器，应由独立索引任务或 CI 生成产物，保持诊断 Runtime 的只读边界。Swift↔Objective-C、Java↔Kotlin、JS Bridge 和反射调用要单独测，不能由“分别支持两种语言”推导混编关系完整。

## 4. 与现有项目的接入边界

目标是一个统一的代码检索能力接口，底层引擎可替换；不另造一套负责诊断的 Agent。长期能力分类如下，以下名称是设计目标，并非当前工具清单：

- `search_code_text`：精确文本及有界正则检索。
- `find_symbol`、`find_definition`、`find_references`：声明和引用导航。
- `find_callers`、`find_callees`：有能力的语言适配器提供调用关系。
- `search_code_pattern`：可选结构搜索。
- 源码回读继续复用有界、只读且能进入证据链的工具。

当前保留 `search_project_text`，新增符号候选、文件大纲和静态调用候选三个导航工具：
`search_code_symbols`、`get_code_outline` 和 `trace_code_path`，不承诺精确的定义/引用解析。
Runtime 只把它们作为 Repository MCP 工具发现结果挂载；CBM
命令、索引缓存、索引创建和删除接口不进入模型工具面。未配置 CBM 时不挂载扩展
工具，继续使用 `search_project_text`；已配置但命令不可用时显式返回能力错误。
所有导航结果都带有证据边界，必须再调用 `read_project_file` 才能形成源码观测。

内部适配器锁定 CBM 0.12.1 的 `fast` 模式；复制授权范围内的允许代码文件后建立索引，不在原仓库写产物。索引身份使用工作区根目录、源码内容指纹、引擎身份和适配器模式；查询前后检查源码和副本，拒绝轮内变更或损坏的缓存。`source-views/` 与 `engine/` 分开保存，避免上游自动排除缓存子目录。子进程无 shell，限制输出与超时，取消时终止 CLI 进程组；CBM 自身的共享后台进程仍由上游管理，CLI 取消不保证已提交的后台索引任务也立即结束。返回能力错误后由 Agent 改用现有文本搜索，不会把失败自动转换成空命中。

Runtime 从会话绑定上下文注入 repository/snapshot，模型不能通过自由路径参数跨仓库。适配器要区分“不支持”“未索引”“索引过期”“没有匹配”和“结果截断”，不返回一个空列表掩盖能力缺口。

索引身份至少包含 `repository_id`、commit 或本地工作树内容指纹、索引/解析器版本及配置指纹。同 commit 的不同 SDK/编译参数也可能改变语义解析，因此语义索引还需记录对应工具链和构建上下文。索引不匹配时拒绝关系查询或显式降级到当前工作树实时搜索，不能回读另一个 commit 后仍引用旧图。

源码/日志才是当前故障观测。索引返回的路径、符号摘要和推断边不直接进入账本；回读时由 Runtime 校验来源与快照，记录实际原文和范围。新增能力继续保留工具调用/返回配对、取消、输出预算和报告门禁，不通过额外大结果绕过现有成本限制。

Docker 的代码索引属于可重建派生产物，但需要独立持久卷保存，避免每次部署全量重建。业务知识、会话事实、源码快照与索引分别管理；清理索引不能删除会话事实。共享索引按 repository+snapshot 复用，访问授权仍按会话校验。

## 5. HarmonyOS PoC 实测

本轮使用本机的 `xesapp_xuejia_hd/lc_stu_harmonyos` 工作区做只读测试。HEAD 为 `5c768f8975bde510676345deecd0aea9911ff6ba`，分支为 `feature/20260324`；工作区当时有 2 个已有修改，因此不能当作发布版本基准。引擎锁定 0.12.1，使用独立临时二进制和缓存，没有修改源仓库、全局 MCP 配置或本项目 Runtime。

测试对象是课堂工程，不能用“组合加购”未命中来判断检索失败。为排查资源噪声，还复制了其中 649 个可见 `.ets` 文件做对照索引；该副本仅用于检索实验，不是可构建的完整项目。结构化查询结果、ArkTS 文件清单指纹及限制见 [PoC 结果](../experiments/code_index/harmonyos-poc-2026-11-11.json)。清单指纹只覆盖这 649 个文件，不代表原仓库全部内容。

### 5.1 基线与索引结果

| 项目 | 现有 Repository MCP | `ripgrep` | codebase-memory-mcp 0.12.1 |
| --- | ---: | ---: | ---: |
| `XOLWebViewJavascriptBridge` 命中 | 16 | 16 | 16 个文本命中 |
| `GroupClassViewModel` 命中 | 9 | 9 | 1 个 Class 符号 + 2 个调用方 |
| `@ComponentV2` 命中 | 本轮显式设为 50 条并标截断 | 249 | 249 个文本命中 |

现有搜索默认上限是 10，本轮为了比较显式设置为 50。初步单次计时中，Repository MCP 为约 200–630ms，ripgrep 为约 38–130ms；两者部分查询的文件范围不同，且没有统一冷/热缓存，不能据此计算性能提升倍数。codebase-memory-mcp 的 `search_code` 报告约 187–202ms 的内部检索时间，其中包含文件扫描；这不是图查询端到端延迟，也不能与前两项直接比较。CLI 另有临时 daemon 启动成本。

完整工作区首次索引由工具报告约 11.6 秒，产出 28,213 个节点和 98,765 条边；`parse_partial` 和 `parse_unusable` 均为 0。ArkTS 副本索引约 2.9 秒，产出 14,665 个节点和 65,234 条边，未索引、跳过和解析异常计数均为 0。解析器未报错不等于关系完整或语义正确。

符号导航经源码抽查可以对应：`GroupClassViewModel` 返回 Class，范围为 `32-648`，文件 outline 共 58 项；`GroupSignPage` 和 `GroupPermissionPage` 正确识别为 Struct。`@Builder` 方法 `GroupSignPage.navigationBar:88`、`GroupSignPage.GroupItemBox:103` 和 `GroupPermissionPage.navigationBar:322` 的名字与范围也对应源码。这验证了部分 ArkUI 特有结构，不能推导所有 UI DSL 和装饰器都支持完整。

调用关系由独立只读核对与源码搜索交叉检查：

| 查询 | 图返回 | 源码核对与局限 |
| --- | --- | --- |
| `GroupClassViewModel` 入向 | 两个页面的 `viewModel` getter，`heuristic / 0.95` | 对应 `GroupSignPage:33`、`GroupPermissionPage:59` 的显式 `new` |
| `signInToGroupInfo` 入向 | `changGroupFromSourceGroupId`，`heuristic / 0.38` | 对应 ViewModel 第 331 行调用 |
| `getGroupsInfo` 入向 | `loadGroupInfoData`，`heuristic / 0.38` | 第 455 行实际处于嵌套回调和 `setTimeout` 内，图只归到词法所属方法，未表达异步执行顺序 |

这些关系可以辅助缩小源码范围，但分数是工具输出，并非本项目测得的准确率；不能据图证明本次故障实际走过这条路径，也不能据空结果排除动态调用。

### 5.2 发现的限制

- `XOLWebViewJavascriptBridge` 是外部导入类型，代码文本搜索可以找到 16 处，但图索引没有把它当作仓库内定义的可导航符号。这是正确的能力边界，不能把外部 SDK 类型误报成本仓库定义。
- 英文语义查询 `student group sign in before class` 的 Top 10 主要是 AICorrect 等实现；中文查询 `上课前 小组签到 进班` 还召回压缩后的 `crypto-js` 和 MathJax。两条查询均没有把已核实的小组签到 `beforeClass` 实现排进 Top 10。这是两个样本的失败，不能扩大为整个引擎的总体准确率结论。
- 排除资源文件的 649 个 `.ets` 副本中，同样两条查询仍未把目标排进 Top 10；中文结果主要是像素转换、压缩和加密工具。因此问题不只来自第三方资源噪声，当前配置下的自然语言入口没有通过这组样本。
- 对照使用人工构造的英文检索词 `group sign` 做 BM25，第一项是 `signInToGroupInfo`，前五项均在相关小组签到实现中。它说明“术语 → 符号检索”有试验价值，但不是独立业务问句集上的成功率评测，也未验证知识库能自动给出这些词。
- `search_graph` 同时传 `file_pattern='*.ets'` 和中文 `semantic_query` 时，`semantic` 结果仍含 `.js`；普通图结果与语义结果的过滤行为不同。该版本的这个参数不能作为语义范围保证。正式接入需在索引构建或适配器中约束范围，并另验收过滤行为。
- 完整索引纳入了部分 `rawfile` 下的压缩 JavaScript。需要配置第三方/生成目录排除规则，并披露覆盖范围；本轮没有证明清理噪声就能解决自然语言召回。
- 当前结果是 dirty 工作树的索引。产品必须绑定 `repository_id + commit` 或工作树指纹；代码变化后要重建或明确拒绝旧索引，不能复用本次实验结果。
- 独立 CLI 调用能复用缓存，但 `index_status` 显示本轮项目没有自动监听；文件变化需显式刷新。尚未验收增量更新、并发、取消及 Docker 重启复用，不能把本机缓存复用等同于部署验收。

### 5.3 阶段结论

HarmonyOS 方向可以继续试，但要限定为 **代码索引 PoC**：

1. 保留当前 Knowledge MCP 做业务规则判断和中文术语召回。
2. 优先试用本轮验证过的文件 outline、符号搜索和调用方候选；定义/引用完整性、跨模块解析继续单独验收。
3. Runtime 回读同一快照源码后，才把内容登记为 `source` 观测。
4. 本轮自然语言样本未通过，暂不作为产品入口；后续更换配置或检索方案后重新比较。
5. 下一轮用固定的 HarmonyOS 问题集评估“业务知识 → 精确技术词 → 代码索引”的完整链路，再决定是否接入 Runtime。

### 5.4 复跑入口

以下使用已安装的 0.12.1 CLI，在独立缓存内重新建索引。路径由执行者替换，不写入源仓库图产物；MCP 返回的索引摘要仍不是证据。

```bash
export CBM_CACHE_DIR="$(mktemp -d -t harmony-code-index)"
CBM_BIN=/path/to/codebase-memory-mcp
HARMONY_REPO=/path/to/lc_stu_harmonyos

"$CBM_BIN" cli --json index_repository --repo-path "$HARMONY_REPO" --name harmony-poc --mode full
"$CBM_BIN" cli search_graph --project harmony-poc --name-pattern '^GroupClassViewModel$' --label Class --format json
"$CBM_BIN" cli get_file_outline --project harmony-poc --file-path features/classroom/src/main/ets/beforeClass/pages/GroupSignPage.ets --limit 100 --format json
"$CBM_BIN" cli trace_path --project harmony-poc --function-name signInToGroupInfo --direction inbound --depth 1 --include-evidence true --format json
"$CBM_BIN" cli search_graph --project harmony-poc --query 'group sign' --limit 10 --format json
"$CBM_BIN" cli search_graph <<'JSON'
{"project":"harmony-poc","semantic_query":["上课前 小组签到 进班"],"semantic_limit":10,"limit":1,"format":"json"}
JSON
```

复核时继续用文本搜索确认调用点，并读取返回行号附近的实际源码。固定版本评测应改用隔离的干净快照；本轮命中和范围只对应当时的 dirty 文件内容。

### 5.5 `rg + ast-grep + zvecgrep` 组合实测

为验证候选组合，本轮在同一课堂工程上使用临时安装的 `ast-grep` 0.51.1 和 `zvecgrep` 0.3.0；没有写入项目依赖，也没有修改源仓库。结构化结果与环境失败信息见 [组合 PoC 结果](../experiments/code_index/harmonyos-search-stack-poc-2026-11-11.json)。

| 组件 | 实测结果 | 判断 |
| --- | --- | --- |
| `rg` | 原始 `.ets` 可直接搜索，`new GroupClassViewModel` 找到 2 处，约 80ms | 可作为稳定底座 |
| `ast-grep` 直接扫 `.ets` | 显式指定 TypeScript 后仍无法稳定识别 `.ets` 中的 `new`、`struct` 和 ArkUI 装饰器；outline 只能返回少量标准常量 | 不能直接当 ArkTS 结构查询 |
| `ast-grep` 扫 `.ets → .ts` 内容副本 | 能识别 2 处 `new GroupClassViewModel`、标准 `class` 和 `this.$METHOD($$$ARGS)` 调用模式；`export struct` 仍不是 TypeScript 语法 | 只能验证标准 TS 子集，不能证明 ArkUI 结构支持 |
| `zvecgrep` 直接扫 `.ets` | 0 个可索引文件，工具明确将 `.ets` 判为 unsupported | 当前版本不能原生索引 ArkTS |
| `zvecgrep` 扫 `.ets → .ts` 内容副本 | 文件类型可进入扫描，但本机没有 embedding 模型；Hugging Face 请求超时，ModelScope 返回 403，索引在模型初始化阶段失败 | 语义质量尚未测出，不能把失败误判为召回差 |

因此，组合方案目前只能落成：**`rg` 生产可用，`ast-grep` 和 `zvecgrep` 实验性等待 ArkTS 适配**。把 `.ets` 改名为 `.ts` 只能作为探针，不能成为正式方案：它会掩盖 ArkUI `struct`、装饰器和 DSL 与标准 TypeScript 的语法差异，且结果行号、快照身份和错误语义都需要额外维护。

下一步若要继续验证，应先做一个只读 ArkTS 适配层：保留原始 `.ets` 路径和行号，将工具需要的临时输入与原文件建立映射；同时准备本地 embedding 模型或明确批准的远端 embedding 服务。适配层通过固定问题集后，才比较语义 Top-k、首建时间、增量时间和上下文成本。

## 6. 当前需先解决的缺口

本节以调研时的工作区代码为准，包含尚未提交的重构；不据旧架构文档判断当前日志接线是否完成。

1. `mcp_server/src/harmony_repo_mcp/inspector.py` 的 `search_project_text` 当前逐文件读取匹配，没有常驻倒排或符号索引；搜索候选默认受 5,000 个文件上限约束。先测实时 ripgrep 基线，再决定是否需要常驻索引。
2. 同一文件白名单缺少 Swift、Objective-C、Objective-C++、Java、Kotlin、Kotlin Script、TSX，影响列目录、搜索和读取。三端源码/配置覆盖及各自的日志/堆栈格式需先验收。
3. `runtime/src/diagnosis/agent.ts` 的角色仍声明 HarmonyOS；`orchestration/plan.ts` 的预留 `clientPlatform` 类型只允许 `harmony`。不能因仓库配置已有三端枚举就宣称整个产品已支持三端。
4. `knowledge/README.md`、`_schema.md`、ADR 0001/0002 仍要求代码位置或代码锚点；`locator-guidance.ts` 还从知识文本推导位置。变更职责时必须同步设计过渡，不能只删除 Markdown 中的路径。
5. 平台/版本事实与绑定快照仍需在源码能力层强约束，不能只靠提示词。现有精确版本选择函数与字段不代表选择和证据隔离已经完成闭环。
6. 旧知识混合了业务适用范围与实现核验范围。逐条按来源复核，不能把 `applies_to: [harmony]` 批量扩为三端；版本匹配也需要处理多段 App 版本，不能用浮点数比较。

## 7. 实施顺序与验收

**第一步：固定职责并修齐基础覆盖。** 评审业务知识边界；识别应保留的业务规则和应迁出的纯代码导航。保留条目 ID、人工核验状态、来源、跨域引用及全局回退。修齐三端源码可见性和平台/版本绑定约束。

**第二步：小规模 PoC。** 对同一组 HarmonyOS、iOS、Android 固定快照，比较现有扫描、ripgrep、codebase-memory-mcp；至少覆盖 ArkUI DSL、Swift 协议/扩展、Objective-C selector/头文件/`.mm`、Java 重载、Kotlin 扩展/协程，以及三端共同的业务描述。

**第三步：依据结果确定引擎。** 单仓库与少量快照先选择成本最低的可用组合。需要多人共享大量仓库时比较 Zoekt/Sourcebot；中文自然语言定位仍漏召回时再加入 CocoIndex 等对照；需要更精确引用时再引入构建型索引或语言服务。

验收同时记录：

- 文件覆盖率、符号定位 Top-k、定义/引用准确性、调用关系的误连和漏连；没有返回不能自动算作正确。
- 首次构建时间、增量时间、冷/热查询耗时、CPU/内存/磁盘和 Docker 重启复用。
- 每个问题的总调用数、返回载荷、模型 Token、总耗时和诊断质量；成功、失败、降级全部计入成本。
- 错端/错版本、工作树变化、同名符号、索引损坏/缺失/过期、取消、并发和未授权快照查询。
- 知识规则可独立回答、知识未命中能继续调查、跨端线索不被硬过滤、源码实际回读且图摘要不能冒充证据。

知识规范或检索指引修改后执行 `make knowledge-validate`；修改 loader、retriever 或知识 MCP 时，再执行项目规定的知识与查询日志测试。代码索引接入另跑对应 MCP/Runtime 回归。当前没有真实三端代码基准结果，不承诺性能提升倍数。

## 8. 调研限制

本次读取上述 GitHub 项目的文档、语言支持表和相关实现，并实际运行了 codebase-memory-mcp 0.12.1 的 HarmonyOS PoC，也完成了 Repository MCP 内部桥接和合成 Runtime/MCP 验收；`ast-grep`/`zvecgrep` 的实验限制见 §6。Zoekt、Sourcebot 和 CocoIndex 等未部署实测，iOS/Android、真实问题端到端诊断和生产性能指标仍未验收。文中多数源码链接指向可变分支，不能把 main 的全部能力归于本轮 release；后续比较应分别锁定版本和配置。

内部封装另在同一真实 HarmonyOS dirty 工作树做了[冒烟验证](../experiments/code_index/harmonyos-mcp-bridge-smoke-2026-11-11.json)：复制 681 个允许代码文件，页面 outline 返回 16 个符号，`signInToGroupInfo` 返回一个静态调用方候选，并成功回读原文件；这不是召回率或诊断质量验收。首次接入曾误将源码副本放在 `CBM_CACHE_DIR` 内，上游因此排除了子目录；修复后按源码副本与引擎缓存分离复测通过。仍有 8 个文件被引擎排除，返回覆盖计数，不假设全量解析。

尝试通过 `devecocli docs search` 核对鸿蒙官方资料时，本机检测到的 DevEco 版本为 `1.0.0`，低于 CLI 要求的 `6.1.0`，未能完成该检索。因此 ArkTS 结论限定于开源 grammar 与源码支持核对，不代表官方语义能力已验收。
