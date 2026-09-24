---
name: lesson-type-and-livetype-codes
domains: [learning, order]
kind: platform-fact
applies_to: [harmony]
authority: code
updated_at: 2026-09-23
verified_at: 2026-09-23
description: 课次类型字段 lessonType 的枚举（选修讲=5）与上课模式编码 livetype（小班课=100、智能伴学=22、书机结合=23）
aliases:
  - 选修讲是什么
  - 三讲一测是什么
  - 学期报告是什么课次
  - 课次类型
  - livetype 是什么
  - 小班课的编码
---

# 课次的类型编码（`lessonType` / `livetype`）

## 事实

**`lessonType`——课次类型**（学习页课次列表里用来区分不同类型的"讲"）：

| 值 | 含义 |
| --- | --- |
| `0` | 课前准备 |
| `1` | 正常课 |
| `2` | 考试类 |
| `3` | **三讲一测** |
| **`5`** | **选修讲** |
| `6` | 学期报告（2021-08-12 版本新增） |

> **⚠️ 枚举里没有 `4`**——不要按顺序猜值。

**`livetype`——上课模式的编码**（班课后台字段）：

| 值 | 含义 |
| --- | --- |
| **`100`** | **小班课**（大学生在线课，**不支持接流**） |
| **`22`** | **智能伴学**（托管） |
| **`23`** | **书机结合**（托管） |

托管那两个见 [[class-replay-and-cloud-listening]]；
「上课模式」与「课中交互模式」的区别见 [[class-mode-vs-interaction-mode]]。

**选修讲是什么**：挂在课程下的**可选讲次**，有自己的**直播讲 id**，可以**单独变动 / 删除**——
所以会出现「**长期班已经结课了，里面的选修讲还没结课**」这种情况。

## 判据

用户说「选修讲 / 三讲一测 / 学期报告是什么」时：

1. 它们是**课次类型**（`lessonType`），不是独立的课程——客户端在
   `XesCourseCenter/src/main/ets/components/view/LearnLessonListComponent.ets`、
   `components/viewmodel/ClassLearnDetailBean.ets` 里按这个字段区分；
2. **选修讲 = `5`**——搜「选修讲」中文注释能找到，但**服务端下发的字段是数字**；
3. 「**小班课**」在后台是 `livetype=100`，且**课程限额 ≤35** 才可选、
   **小班课的直播讲不能被接流**。

## 例外

- `lessonType` 的注释是 2021 年版写的，**后续可能追加过新类型**（枚举缺 4 也说明它被改过）；
- `livetype` 的值**散落在多篇文档里，没有单一权威表**——上表是拼出来的，遇到新值以服务端为准。

## 来源

- **客户端注释**（本条目枚举的直接出处）：`XesCourseCenter` 的 `ClassLearnDetailBean.ets`、
  `LearnLessonListComponent.ets`
- 《240320 | 大学生在线课支持"小班课"》知音楼 `https://s.tal.com/a/NX4AHG`（2024-02-21，郭明真）——
  **`livetype=100`、小班课不支持接流、课程限额 ≤35** 的来源
- 《240130 | 班课-托管班级支持2种上课模式》知音楼 `https://s.tal.com/a/ChJyJY`（2024-10-01）——
  `livetype` 22 / 23 的来源
- 《260324 | 班课-选修讲管理面板V1-支持查看》知音楼 `https://s.tal.com/a/TupnyW`（2026-06-04，郭明真）——
  **选修讲可独立变动 / 删除、"长期班结课了选修讲可能还没结"** 的来源
- 文档均为**人工核实入口，agent 无访问能力**。

**客户端代码核对结果**（仓库 `xesapp`，分支 `releaseV/20260921`，2026-09-23）：
「选修讲」**有命中**（两处 `lessonType` 注释），是少数**中文能直接在客户端搜到**的班课概念；
「三讲一测」「学期报告」同样出现在该注释里。
