---
name: renewal-cross-business-line
domains: [order]
kind: platform-fact
applies_to: [harmony]
authority: internal-sop
updated_at: 2026-09-23
description: 续报班与原班的业务线曾经必须一致，2025-05 才放开「小学素养→初中彼芯」「初中彼芯→高中学科」两种跨线续报
aliases:
  - 续报不了
  - 续报时选不到班
  - 能不能跨业务线续报
  - 为什么续报选不到彼芯的班
  - 续报班
---

# 续报能不能跨业务线

## 事实

**续报班和原班的业务线，曾经必须一致**——彼芯项目初期因业务要求限制成
「**续报班和原班必须同属彼芯、或同不属彼芯**」，这条逻辑**延续了很久**。

**2025-05 放开**，为的是两种真实业务场景：

- **小学素养 → 初中彼芯**；
- **初中彼芯 → 高中学科**。

放开前这两种情况**只能靠批量报名绕**，效率很低。放开的做法是**放开「续报班 id」的模板与导入校验**：
课程导入覆盖**面授 / 托管 / 自学课**，班级导入覆盖**在线 / 双师**。

代码位置（鸿蒙侧）：

| 环节 | 文件 |
| --- | --- |
| 购课单续报（原班选择弹窗、列表） | `XesOrder/src/main/ets/components/shoppingCart/BuyClassOldClassDialog.ets`、`BuyClassListPager.ets`、`BuyClassListItem.ets` |
| 订单模型的续报字段 | `XesOrder/src/main/ets/components/orderBusiness/Model/OrderQueryStateModel.ets`（`renewal` / `renew`） |

## 判据

用户 / 顾问说「续报不了 / 续报时选不到目标班」时：

1. **先问是不是跨业务线**（小学素养→初中彼芯、初中彼芯→高中学科）；
2. **2025-05 之前**这种"跨线续报不了"是**刻意限制**（彼芯项目初期定的），之后**已放开**；
3. 放开后仍续不上，要看**分校 / 年级 / 续报窗口**，**不要再往业务线上归因**。

## 例外

- 放开的是**指定的两种组合**，不是任意跨业务线；
- 改动经过数据 / 财务 / 订单 / 计收多方确认，**历史数据是否有遗留限制以当前版本为准**；
- 客户端**「续报班」中文零命中**（只有「续报」），字段名走 `renewal` / `renew`。

## 来源

- 《250617 | 班课-支持跨业务线续报》知音楼 `https://s.tal.com/a/tqdgsZ`（2025-05-13，郭明真）
- **人工核实入口，agent 无访问能力**。

**客户端代码核对结果**（仓库 `xesapp`，分支 `releaseV/20260921`，2026-09-23）：
「续报」命中 `XesOrder` 的 `shoppingCart/` 三个文件；「续报班」**零命中**；
`renewal` / `renew` 命中 `OrderQueryStateModel.ets`。
