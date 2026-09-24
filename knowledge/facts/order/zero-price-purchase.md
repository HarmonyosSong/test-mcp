---
name: zero-price-purchase
domains: [order, payment]
kind: platform-fact
applies_to: [harmony]
authority: code
updated_at: 2026-09-23
verified_at: 2026-09-23
description: 0 元课按业务线开放（1对1 限诊断类、大学生限按课次定价）；客户端走的是「领券报名 + 自动报名」，不是免费
aliases:
  - 0元课
  - 免费课
  - 为什么有0元的课
  - 0元购
  - 0元为什么还要领券
  - 课次金额能填0吗
---

# 0 元课的适用范围与实现

## 事实

**「能不能开 0 元的课」按业务线不同**，而且**都卡在「课次」这一层，不是整班**：

| 业务线 | 规则 |
| --- | --- |
| **1对1** | **诊断类** 1v1 商品的**课次单价可 ≥0**；**其它类型必须 ≥1** |
| **大学生** | **定价模式 = 按课次设置金额**（**目前只应用于大学生**）时，**课次金额可 = 0**（范围 `[0, 999999]`） |
| **共同底线** | **长期班 / 短期班的整班金额不得为 0**——财务要求，靠**全局参数**拦截 |

**大学生为什么要 0 元**：直播 ＋ 录播的课程里**录播必须设价格、最低是 1**，
而**托福 4 个科目的录播数量不一致**，导致各科总价不一致——
拉齐总价的办法就是把**录播课次的价格设为 0**。

**0 元在客户端不是"免费"，是「领券」**：

| 环节 | 文件 |
| --- | --- |
| 0 元购 / 领券报名 | `XesCourseCenter/src/main/ets/components/view/classdetail/ClassDetailPage.ets`、`components/ClassDetailBottomComponent.ets`（注释即「0元课领券报名」） |
| 0 元购自动报名 | `XesCourseCenter/src/main/ets/components/net/CourseCenterApi.ets`（注释「立即报名-0元购自动报名」） |
| 报名 / 支付组件 | `XesCourseCenter/src/main/ets/register/RegisterAndPayComponent.ets` |
| 收银台 | `XesOrder/src/main/ets/components/cashDesk/XesAppCashierDeskViewController.ets` |
| 首页 0 元文案 | `XesHomePage/src/main/ets/bean/HomeExperienceListBean.ets`（`freePriceText`） |

也就是说：**0 元课走的是优惠券链路**（把应付金额减到 0），并且**0 元购会「自动报名」**，
不跳收银台——所以"我点报名直接就成功了、没让我付钱"是**设计如此**。

## 判据

用户 / 顾问说「开不了 0 元的课 / 0 元怎么还要领券」时：

1. **先看业务线**——1对1 只有**诊断类**能 0 元，大学生只在**按课次定价**时能 0 元；
2. **「课次 0 元但整班金额不为 0」是正常的**——0 元是**课次级**的额度，整班金额另有财务底线；
3. **「0 元为什么要领券」**——客户端 0 元的实现就是**领券把金额减到 0**，不是把商品设成免费；
4. **「0 元点一下就报名成功了」**——**0 元购自动报名**，不经过收银台。

## 例外

- 「按课次设置金额」这个定价模式**目前只应用于大学生**；
- 两处 0 元的**动机不同**：1对1 是**做转化**（0 元诊断课，学员走**无感知流程**），
  大学生是**拉齐各科总价**；
- 客户端有「0元购 / 0元课领券报名 / freePriceText」等中文注释，**这是少数中文能直接搜到的购买链路**。

## 来源

- 《251216 | 班课-1对1诊断商品支持0元》知音楼 `https://s.tal.com/a/2k6kkD`（2025-11-10，郭明真）——
  1对1 诊断类可 0 元、其它 ≥1
- 《240731 | 班课-大学生课次金额支持0》知音楼 `https://s.tal.com/a/wWYWQS`（2024-07-02，郭明真）——
  大学生按课次定价可 0、录入与整班金额的财务底线
- 均为**人工核实入口，agent 无访问能力**。

**客户端代码核对结果**（仓库 `xesapp`，分支 `releaseV/20260921`，2026-09-23）：
「0元」命中 `XesCourseCenter`（领券报名、0元购自动报名）、`XesOrder`（收银台 0 元购）、
`XesHomePage`（`freePriceText`）；**「免费」零命中**——端上统一用「0元」这个说法。
