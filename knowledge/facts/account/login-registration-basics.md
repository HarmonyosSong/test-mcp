---
name: login-registration-basics
domains: [account]
kind: platform-fact
applies_to: [harmony]
authority: code
updated_at: 2026-09-23
verified_at: 2026-09-23
description: 登录注册的手机号校验规则（各地位数与展示格式）与「查询学员编号」入口
aliases:
  - 收不到验证码
  - 手机号格式不对
  - 提示手机号错误
  - 忘了是哪个账号
  - 查询学员编号
  - 我有几个学员账号
  - 登录遇到问题
---

# 登录注册：手机号校验与查询学员编号

## 事实

**手机号格式校验**——在**获取验证码之前**拦截，避免用户白等短信：

- **字符**：仅允许阿拉伯数字；
- **长度**（均**不含**国家地区码）：大陆 **11** 位、香港 **8** 位、澳门 **8** 位、台湾 **10** 位、
  其他国家和地区 **11** 位；
- **展示规范**（按地区分组）：大陆 344（`133 4444 5555`）、港澳 44（`1234 5678`）、
  台湾 433（`1234 555 666`）、其余地区统一 344。

**「查询学员编号」**——登录遇到问题时用：

输入**手机号 + 验证码**，可查询该手机号下注册的**所有**学员编号。结果里展示头像、昵称、
在读年级、注册城市；家庭电话已隐藏，「母亲 / 父亲电话」改称「联系电话 1 / 2」。

代码位置（鸿蒙侧）：

| 环节 | 文件 |
| --- | --- |
| 登录页 | `XesBusiness/XesLogin/src/main/ets/xeslogin/pages/LoginPage.ets` |
| 查询学员编号（输入） | `XesMine/src/main/ets/components/student/SearchStudentNoPage.ets` |
| 查询结果页 | `XesMine/src/main/ets/components/student/QueryStudentResultPage.ets`、`view/QueryStudentResultItem.ets` |
| 学员编号展示与复制 | `XesMine/src/main/ets/components/student/StudentInfoPage.ets` |

## 判据

用户说「收不到验证码 / 手机号提示不对」时：

1. **先按位数核对**——港澳台用户的号码位数与大陆不同（8 / 10 / 11），
   位数不符时会在**获取验证码前**就被拦下，**短信根本不会发**；
2. 用户说「我忘了是哪个账号 / 我有几个孩子」→ 指引到**查询学员编号**（手机号 + 验证码）；
3. **一个手机号下可以挂多个学员编号**——「登录后看到的孩子不对」往往是这个原因。

## 例外

- 手机号格式校验的**提示文案在客户端零命中**（已核对），判定逻辑可能在服务端；
- 「查询学员编号」入口在登录遇到问题时出现，具体路径以当前版本为准。

## 来源

《【20251216】APP登录注册样式改版》知音楼 `https://s.tal.com/a/db8bAt`（2025-11-24）——
**人工核实入口，agent 无访问能力**。

**客户端代码核对结果**（仓库 `xesapp`，分支 `releaseV/20260921`，2026-09-23）：
「查询学员编号」命中 `XesMine` 的查询页与结果页；登录页在 `XesBusiness/XesLogin/`；
「手机号格式」零命中（文案不在客户端）。
