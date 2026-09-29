---
name: error-book-upload-file-types
domains: [learning]
kind: platform-fact
applies_to: [harmony, ios, android]
authority: official
updated_at: 2026-09-28
verified_at: 2026-09-28
description: 错题本录入(上传错题)仅支持图片——C端必填图片、单张≤4M、最多8张;B端jpg;PDF只是导出格式
aliases:
  - 错题本支持什么格式
  - 错题本能传PDF吗
  - 错题本可以上传PDF吗
  - 错题本只能传图片吗
  - 错题本上传图片大小限制
  - 上传错题选完文件没反应
  - 错题本传不了文件
---

# 错题本录入文件类型(仅图片)

## 事实

错题本**录入(上传错题)只支持图片**,不支持 PDF 或其他文档类型:

- **C 端(学员/家长,小驴 H5)**:「上传图片」为必填项;产品文案:「上传图片时,请将纸张
  清晰完整拍摄,**单张图片大小不能超过 4M,最多上传 8 张**」;
- **B 端(授课工作台)**:支持批量上传,最多 8 张,**上传格式为 jpg 文件**,单张大小限制 4M;
- **PDF 仅出现在导出方向**:错题导出/打印/分享使用 PDF(PDF 名称、样式、paper4.0),
  与录入无关——录入侧全文未提 PDF。

## 判据

用户反馈「错题本传不了文件 / 选了文件没反应」时:

1. 业务契约就是图片——选 PDF、Word 等文档类型本来就不被支持,不是功能缺失;
2. 若某端**能选到 PDF**(系统文件选择器放开了类型)→ 问题在**容器层未按 H5 accept
   收敛文件类型**,而非业务侧放开了 PDF;
3. 鸿蒙侧容器(2026-09-28 按 `releaseV/20260921` 代码核实):`XesWebView/src/main/ets/
   components/webview/WebView.ets:163` 的 `onShowFileSelector` 直接接管并 `return true`,
   **全程未读取 H5 的 accept**;「文件」分支 `openDocumentUploadPicker()`(123-139 行)用
   默认 `picker.DocumentSelectOptions()`,**未设 `fileSuffixFilters`**——系统选择器必然
   放开 PDF 等全部类型。「能选到 PDF」即容器未收敛,已成立;
4. 旧容器 `XesWebView/src/main/ets/components/XesWebview.ets` 是另一套实现(桥接分工见
   [[error-book-entry-picai-only]]);工单实际走 V1(`talxesapp://Main/Browser`)还是
   V2(`AIWebContainer`)需按页面确认,两套都未做 accept 收敛时结论一致。

## 例外

- 规则出自 v1.0.241218(2024-12)需求文档;后续月份版本(如 20260921 版,讲数感题录入)
  未逐一核对——工单时间明显晚于 2024-12 时,注意确认是否存在新版录入规则;
- 「最多 8 张、单张 4M」是产品文案层限制,实际上限以当前线上 H5 表现为准;
- 导出方向支持 PDF 不代表录入支持,两个方向不要互相推断。

## 来源

知音楼《授课工作台/C端错题本优化-1218版本》(v1.0.241218,2024-12),node_id
`879561950726701110`,位于《培优前驱产品》→ 老师平台(原小驴)→ 错题本&考点地图&刷题
→ 小驴2024-2025。2026-09-28 经知音楼 lore 工具通读原文上传章节核实;
与人工工单核对结论「错题本只支持图片」一致。
