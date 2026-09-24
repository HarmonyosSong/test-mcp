---
name: trial-class-pay-after-satisfaction
domains: [payment, order, learning]
kind: platform-fact
applies_to: [harmony]
authority: code
updated_at: 2026-09-22
verified_at: 2026-09-22
description: 「先满意再缴费」允许家长先体验 3 讲再缴齐费用，代码里的字段叫 trialClass
aliases:
  - 先满意再缴费
  - 可以先上课再交钱吗
  - 体验课
  - 免费上三节课
  - 为什么这个班不用先付钱
  - 先上课后付费
---

# 先满意再缴费（trialClass）

## 事实

T6 新分校的招生模式：家长**不付费先体验 3 讲**，满意后一次性缴齐费用。

**版本演进**：0120 版本只能由**顾问**发起，而且**讲次配置是写死的**——所以"4 讲之后报进来就没权益"
是**一刀切**的结果。0226 版本做了三件事：

1. **讲次范围改为服务底层配置**，支持业务**差异化圈班**；
2. **开放 APP / 呼叫 / 盘古的非顾问角色操作**（同时也仍然可以选正常报名）；
3. **加开关**——异常时可**回退成「仅顾问可操作」**。

**文档用词与代码术语不一致，这是本条目最要紧的映射**：

| 文档 / UI 文案 | 代码术语 |
| --- | --- |
| 先满意再缴费 | **`trialClass`**（`TrialClassItem` 类） |
| 价格展示形式 | `trialClass.priceShowType`（`1` = 展示金额，`2` = 先满意再缴费） |
| 试用规则地址 | `trialClass.trialRule` |

代码位置（鸿蒙侧）：

| 环节 | 文件 |
| --- | --- |
| 购课单条目（价格与文案渲染） | `XesOrder/src/main/ets/components/shoppingCart/BuyClassListItem.ets` |
| 购课单列表数据源 | `XesOrder/src/main/ets/components/shoppingCart/viewmodel/CartRootListDataSource.ets` |
| 模型定义 | `XesOrder/src/main/ets/components/shoppingCart/model/CartOrderListItemBean.ets` |
| 支付详情展示 | `XesOrder/src/main/ets/components/orderBusiness/view/PayDetailItemView.ets` |
| 班级详情底部按钮 | `XesCourseCenter/src/main/ets/components/viewmodel/ClassDetailBottomBean.ets` |

参与条件（需求侧）：只有**学科新生**可参与；班级范围是「分校 + 小学年级 + 科学思维 + 面授 + 长期班」
（除产品类型外每项可配），课次范围 **3 讲**；批量报名默认走直接报名，不支持先满意再缴费。

角色分工：报名 ALL、撤单（用户 + 顾问）、缴费（用户 + 教务 + 顾问）。

## 判据

用户问「这个班为什么可以先上课不交钱 / 我怎么没有这个选项」时：

1. 先确认学员资格——**只有学科新生能参与**；
2. 再看班级是否在打标范围内（分校 / 年级 / 学科 / 授课类型 / 产品类型五个维度）；
3. 购课单里这类条目的勾选框会被**主动禁用**（`enabled(!(... priceShowType == 2))`）——是设计如此，不是勾不上；
4. 开班 4 讲之后再报进来不享受权益（0120 版本一刀切的问题，0226 改为按班级范围 + 进度 + 资格共同判断）。

## 例外

- 该链路**只针对面授**；将来若开在线需重新梳理，无法通过配置解决；
- 风险已知：可能存在学员薅羊毛、同行恶意占位，由业务侧自行确认出勤与占班；
- 有开关可回退成「仅顾问可操作」——线上行为异常时先确认开关状态；
- ⚠️ **和「先学后付」到底是不是一回事，需要人工确认**：
  另有 [[learn-first-pay-later]] 一条（素养**科思**业务的「先学后付」，同样是**先上 3 讲再付费**、
  同为 **2026-01-20 上线**），而**本条的 1.0 来源文档标题正是《【260120】科思-先满意再缴费1.0》**、
  打标学科为「科学思维」（即科思）。**两者很可能是同一业务模式的两侧文档**
  （那条讲**学习模块侧**行为、本条讲**交易侧**准入与开关），**也可能不是**。
  **排查时按"用户描述的是学习模块现象还是交易/报名现象"分流**，
  确认前不要拿一条去否定另一条。

## 来源

- 《【260226】先满意再缴费2.0》知音楼 `https://s.tal.com/a/rZ51CL`（2026-02-05）
- 《【260120】科思-先满意再缴费1.0》知音楼 `https://s.tal.com/a/nAqhOb`（2026-01-20）
- 均为**人工核实入口，agent 无访问能力**。

**客户端代码核对结果**（仓库 `xesapp`，分支 `releaseV/20260921`，2026-09-22）：
中文「先满意再缴费」命中 5 处（多为 UI 文案），而业务字段是 **`trialClass`**——
搜中文只能捞到文案字符串，要落到价格展示与试用规则，靠的是 `trialClass` / `TrialClassItem` 这条映射。
