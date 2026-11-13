# 助手回复 Markdown 预览 + 产品改名

## Goal

助手气泡把 Markdown **源码**改成 **GFM 预览**；产品显示名由「鸿蒙诊断工作台」改为「学而思App诊断工作台」。

## Scope

- **做**：仅 `AssistantMessage` 的 `message.content` 渲染；标题/粗体/列表/链接/行内代码/代码块高亮/表格/引用；流式边收边渲；链接新标签；不解析原始 HTML；助手气泡 Markdown 样式；改名（侧栏、页面 title/meta）。
- **不做**：用户消息 Markdown；源码/预览切换；改 `ReportCard`；改知识库/日志里的「鸿蒙」业务语义。

## Approach

`react-markdown` + `remark-gfm` + `rehype-highlight`（highlight.js）。抽 `MarkdownContent` 组件；助手气泡去掉 `pre-wrap`，加 `.chat-markdown`。

## Rename

| 位置 | 旧 | 新 |
|------|----|----|
| `web/src/components/Sidebar.tsx` | 鸿蒙诊断工作台 | 学而思App诊断工作台 |
| `web/index.html` title / meta | 鸿蒙诊断工作台 / 鸿蒙问题诊断工作台 | 学而思App诊断工作台 / 学而思 App 问题诊断工作台 |

## Success

助手回复按 Markdown 排版可读；流式不崩；用户气泡仍纯文本；侧栏与浏览器标签显示新名称。
