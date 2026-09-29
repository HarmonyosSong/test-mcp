---
name: error-book-upload-fails
kind: symptom
symptom: 错题本上传不了
aliases:
  - 传不了错题
  - 上传错题没反应
  - 错题本选完文件返回首页
  - 错题本不能传PDF
  - 错题本上传失败
domains:
  - learning
applies_to:
  - harmony
authority: auto
updated_at: 2026-09-28
description: 依据真实工单与录入规则组织的候选方向,容器侧结论尚待代码核实
---

# 错题本上传不了

## 候选链路

- [[error-book-upload-file-types]]:录入仅支持图片——选 PDF 等文档类型业务侧本就不支持。
  若端上**能选到 PDF**,查容器文件选择器是否未按 H5 accept 收敛(鸿蒙工单:选 PDF 后
  点完成直接返回首页)。
- [[error-book-entry-picai-only]]:入口与桥接分工——详情页是小驴 H5,客户端只有容器与桥接;
  图片上传链路异常也可能在 H5 侧或网络层。

## 区分它们需要什么

1. 选的是什么文件?图片还是 PDF/其他文档——是 PDF 等文档类型直接定位到文件类型契约,
   不必先查网络;
2. 图片也失败 → 先看大小(>4M)与数量(>8 张)限制,再看网络与 H5 侧报错;
3. 鸿蒙端能选到 PDF 本身就是异常信号(选择器类型未收敛),记录该现象,再查
   `XesWebview.ets` 的 `onShowFileSelector` accept 过滤实现。

## 注意

依据 2026-09 鸿蒙真实工单(选 PDF 后返回首页)与 v1.0.241218 需求文档组织;
「容器未按 accept 收敛」已于 2026-09-28 按 `releaseV/20260921` 代码核实成立
(见 [[error-book-upload-file-types]] 判据 3),「点完成后返回首页」的 H5 侧触发点
不在客户端仓库,仍需运行时材料区分。
