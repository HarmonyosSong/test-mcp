# V2 词表 F 阶段审核清单(2026-09-28)

输入:消融 A–E(`.data/knowledge-audit-ablation/ablation.json`)。E 变体发布门槛
6 项过 1 项,退化已全部逐条归因,本清单是 F 阶段「人工审核词表」的决策材料。

用法:每条建议标了挂载概念、类型、误放风险、支撑案例数(challenge = 真实问法
泛化,权重高;anchor = 条目 alias 自查,权重低)。标【审核】的是需要你拍板的,
其余是我认为可直接执行的低风险项。审核通过后我按本清单改词表并复跑消融 F。

## 1. 建议新增 OBJECT(产品/业务术语,误放风险低)

| 概念 ID | 建议 terms | 支撑案例 | 备注 |
|---|---|---|---|
| cloudlearn-study | 云学习 | anchor×1 | 与 cloud-listening(云听课)标 related_to |
| study-home | 学习页、学习首页 | challenge×1 + anchor×2 | 库内高频词,通用度中 |
| class-mode | 智慧伴学、智能伴学、组合小班 | anchor×1 | 产品功能名 |
| course-state | 课态、学习空间 | anchor×1 | 业务术语 |
| lesson-type | 选修课、选修讲、三讲一测 | challenge×1 + anchor×1 | |
| small-stove | 小灶课、第0课、第零课、腾讯会议 | challenge×1 | 腾讯会议是条目明示的上课工具 |
| renewal | 续报 | anchor×1 | 业务术语 |
| praise-wall | 表扬墙 | challenge×1 + anchor×1 | 产品功能名 |
| koubei | 口碑值 | anchor×1 | 产品术语 |
| bixin | 彼芯、彼芯教练 | anchor×1 | 产品术语 |
| three-plus-x | 3+X | challenge×1 | NFKC/casefold 后 3+x 可命中 |
| works | 我的作品 | challenge×1 | 库内功能名 |
| learning-data | 学情数据 | anchor×1 | 与 report(学情报告)不同物 |
| digital-currency | 数字货币 | challenge×1 | 与 agreement 条目联动区分 |
| teacher-homepage | 教师主页、老师主页 | challenge×1 + anchor×1 | |
| calendar | 日历、日历页 | challenge×1 | 同时解 self-study 并列截断(§4) |
| study-task | 学习任务、任务按钮 | challenge×1 + anchor×1 | |
| notice | 购课须知 | anchor×1 | 「抄一段话」是描述不叫法,不补 |
| online-offline | 面授、网课 | anchor×1 | 教育语境具体 |
| resource-slot | 资源位 | anchor×1 | 「弹窗」通用,见 §3  INTENT |
| verification-code | 验证码 | anchor×1 | 库外 App 也会问,但库内有条目,接受 |
| schedule | 课表 | anchor×1 | 通用度中 |
| answer | 答案、答案解析 | regression×2 | 与 handout 标 related_to |

## 2. 现有概念补 term

| 概念 | 补 term | 支撑案例 | 风险 |
|---|---|---|---|
| classroom | 教室 | anchor×1 | 低(现只有「教室号/具体教室」) |
| appraisal | 我的评价 | anchor×1 | 低;「评价」单字不补(好评/差评泛) |
| face-login | 人脸、人脸识别 | anchor×1 | 低;「为什么要采集人脸」现不匹配「人脸登录」 |
| contract | 签约入口 | regression×2 + pilot×1 | 低 |
| invoice | 开票入口、开票按钮 | challenge×1 | 低 |
| quota | 班级满了 | anchor×1 | 【审核】「满了」单补太泛,只补整词 |
| coupon | 券 | anchor×1 | 【审核】单字,库外碰撞面大(§5 负例-4 同源) |

## 3. 建议 INTENT 短语(通用语义的精确问法,比 OBJECT 安全)

通用词补 OBJECT 误放面大,INTENT 是审核过的整句,只在完整出现时召回:

| 概念 ID | 建议 phrases | 指向 | 支撑案例 |
|---|---|---|---|
| search-teacher-intent | 搜不到老师、搜索不出来、搜不到结果 | app-search-behavior | anchor×1 |
| message-missed-intent | 没收到提醒、上课提醒没收到 | message-types-catalog | anchor×1 |
| bridge-native-intent | 调起原生录音、h5 调用原生、H5 调原生失败 | classlearn-h5-bridge-contract | challenge×1 |
| popup-missing-intent | 弹窗不显示了、首页活动没了 | resource-slot-class-expiry | anchor×1 |

## 4. 词已在表但并列截断(同分被挤出 top3)

词表不缺,是 direct_hit3 口径下同分确定性排序把期望条目挤出前三。补区分词后
自然解决,或 F 阶段评估 limit:

| 条目 | 案例 | 联动方案 |
|---|---|---|
| self-study-course-rules | 「自学课在哪」等 | §1 calendar 补后可区分 |
| one-on-one-c-end-purchase | 「1对1怎么买」 | 【审核】purchase ACTION(购买/买课)?「买」单字不补 |
| promotion-coupon-rules | 「优惠券不能一起用」 | 【审核】「叠加/一起用」补哪类?STATE 不计分,需 ACTION |
| shenzhen-digital-currency-protocol | anchor | §1 digital-currency 补后可区分 |

## 5. 负例碰撞 5 条(5/16,门槛 ≤4,差 1)

全是「库外场景 + 库内对象词」合法命中:劳动合同(contract+cancel)、淘宝券
(coupon)、酒店发票(invoice)、银行卡刷脸(face-login)、B站回放(replay)。
检索层返回的是线索,诊断层本应识别库外场景;但评测口径「返回任意 hits 计错」。

【审核】三选一:
- A. 接受现状,口径层面说明(门槛差 1,差距小)
- B. 词表加「库外品牌」标记词(淘宝/酒店/银行卡/B站/公司),命中即降级——
  需要引擎支持负向特征,属设计变更,工作量最大
- C. 给 5 组概念 note 标注碰撞面,F 审核时逐词定「场景限定子类型」

我的建议:先 C 标注、A 接受,把 B 留到 shadow 有真实流量数据后再定。

## 6. 已知接受未覆盖(如实记录,不强行补)

| 查询 | 原因 |
|---|---|
| 体验了三讲但还没付款,为什么不给调课 | 「体验」泛化词,补词代价大于收益 |
| 网页版调起原生录音 handler 在哪注册 | handler 是编程通用词;§3 INTENT 部分覆盖 |
| 付钱之前那份需要家长签字的文件没有弹出来 | pilot;长描述无锚点 |
| 附近五公里筛选(阶段三遗留) | 「附近」无对象概念,同文档既有结论 |

## 7. REGISTERED_SYMBOLS 建议补充

| 符号 | 支撑案例 | 风险 |
|---|---|---|
| lessonType | challenge×1(「lessonType是5」) | 零(驼峰完整标识符) |
| liveType | 同条目 lesson-type-and-livetype-codes | 零 |

不建议入符号表:「H5」「handler」「native」——单 token 通用度太高,违反
符号表「完整边界、误放为零」的收录标准。
