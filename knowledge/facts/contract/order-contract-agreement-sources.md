---
name: order-contract-agreement-sources
domains: [contract, order, payment]
kind: platform-fact
applies_to: [harmony]
authority: code
updated_at: 2026-09-22
verified_at: 2026-09-22
description: 购课链路的「合同」与「协议」是两个独立来源，客户端只各自渲染，互斥规则在服务端
aliases:
  - 付款的时候没让我看合同
  - 购课怎么没签合同
  - 订单确认页没有协议
  - 收银台没有协议
  - 协议去哪儿了
  - 为什么没有电子合同
---

# 购课链路的合同与协议：两个来源，规则在服务端

## 事实

「合同」和「协议」在客户端是**两条独立链路**，客户端不做互斥判断：

| | 合同 | 协议 |
| --- | --- | --- |
| 数据来源 | 服务端返回的 `contract` 字段 | 服务端 `requestPromptInfo` 接口 |
| 客户端位置 | `orderBusiness/ConfirmOrderPage.ets` | `cashDesk/XesAppCashierDeskViewController.ets` |
| 客户端做什么 | 判断是否把签约移到收银台 | 按返回的 `districtsAggr` 数量渲染（1 份 / 多份） |
| 客户端侧业务规则 | 无 | 无 |

**「配了电子合同就不展示协议」这条互斥规则在服务端**——客户端代码里没有任何一处做这个判断。

PRD 侧有直接佐证：《【260427】1对1商品支持签合同》的需求 list 里，合同后端一项写明「开通范围：**服务端按规则写死开通范围**」。

## 判据

用户反馈「付款页没有合同 / 协议」时：

1. **合同侧**：签约是否后置到支付环节，判定在
   `ConfirmOrderPage.shouldMoveContractSignToCashier()`——**去读它**，判定逻辑不在此处复述（抄下来就是会过期的副本）。
   业务背景：1对1 / 高中志愿填报类商品金额大、以 B 端发单为主，所以签约节点后置于支付环节；
2. **协议侧**：客户端只是渲染 `requestPromptInfo` 返回的 `districtsAggr`，
   **返回空就不显示**——「空」本身不等于 bug；
3. **agent 查不到的部分**：服务端为什么返回空（班级配置、互斥规则是否命中），
   需要人工到班课系统的「合同与协议管理」确认。

## 例外

- **待确认**：`contract.state` 的取值语义。代码注释写「0签订合同、查看合同、40||null 隐藏」，
  与 `shouldMoveContractSignToCashier()` 里 `state === 0` 的判断需对齐，别按注释字面理解。
- **待确认**：退费场景（`refund/RefundApply.ets` 有勾选合同协议的 UI）是否复用同一套数据源。
- **课态差异**：托管课态（高中 / 素养业务在用）此前因合规不支持签约，2026-06 起放开
  （一站式班课的合同签订配置新增授课类型「托管」，沿用素养的标准合同）。
  所以**托管课态、且订单在 2026-06 之前的，没有合同属预期行为**。

## 来源

- **文档**（均为**人工核实入口，agent 无访问能力**）：
  - 《电子合同与协议交接文档》知音楼 `https://s.tal.com/a/nkmA2j`（2025-08-28）；
  - 《【260427】1对1商品支持签合同》知音楼 `https://s.tal.com/a/SQ6t7G`（2026-03-31）；
  - 《【260630】电子合同需求文档》知音楼 `https://s.tal.com/a/twDPHD`（2026-05-19）——托管课态放开签约。
- **代码**：仓库 `xesapp`，分支 `releaseV/20260921`（2026-09-22 核对）。

⚠️ **待核实**：客户端侧已代码核对通过（`authority: code`）；但「服务端为什么返回空」这部分**不在本仓库覆盖范围**，
`releaseV/20260921` 无法验证，需服务端同学确认。
