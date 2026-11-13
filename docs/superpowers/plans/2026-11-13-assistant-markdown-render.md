# Assistant Markdown Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 助手消息 GFM 预览 + 产品改名为「学而思App诊断工作台」。

**Architecture:** 新增 `MarkdownContent`，用 `react-markdown` + `remark-gfm` + `rehype-highlight` 渲染助手 `content`；样式挂在 `.chat-markdown`；改名只动前端展示文案。

**Tech Stack:** React 19、Vite、react-markdown、remark-gfm、rehype-highlight、highlight.js

## Global Constraints

- 仅助手气泡渲染 Markdown；用户消息保持纯文本。
- 禁止原始 HTML；外链 `target="_blank"` + `rel="noopener noreferrer"`。
- 不改 `ReportCard`；不改知识库/日志里的「鸿蒙」业务词。
- 用户未要求时不主动 git commit。

---

### Task 1: 依赖与 MarkdownContent

**Files:**
- Create: `web/src/components/chat/MarkdownContent.tsx`
- Modify: `web/package.json`（安装依赖）
- Modify: `web/src/styles.css`（`.chat-markdown` + 代码高亮基础样式）
- Modify: `web/src/components/chat/ChatThread.tsx`（助手气泡接入）

**Interfaces:**
- Produces: `MarkdownContent({ content: string })`

- [ ] **Step 1: 安装依赖**

```bash
cd web && npm install react-markdown remark-gfm rehype-highlight highlight.js
```

- [ ] **Step 2: 实现 MarkdownContent**

组件内：`ReactMarkdown` + `remarkPlugins={[remarkGfm]}` + `rehypePlugins={[rehypeHighlight]}`；`a` 覆写为外链新开；根节点 `className="chat-markdown"`。

- [ ] **Step 3: ChatThread 接入**

`AssistantMessage` 中 `{message.content && <div className="chat-bubble"><MarkdownContent content={message.content} /></div>}`。

- [ ] **Step 4: 样式**

助手 `.chat-bubble` 取消 `pre-wrap`（仅助手，可用 `.chat-message-assistant .chat-bubble { white-space: normal }`）；补充 h1–h3、ul/ol、pre/code、table、blockquote、a 样式；引入 highlight.js 主题或手写 `.hljs` 最小样式适配现有 CSS 变量。

- [ ] **Step 5: 验证**

```bash
cd web && npm run build && npm test
```

Expected: build 与现有测试通过。

---

### Task 2: 产品改名

**Files:**
- Modify: `web/src/components/Sidebar.tsx`
- Modify: `web/index.html`

- [ ] **Step 1: 改文案**

- Sidebar Typewriter → `学而思App诊断工作台`
- `index.html` title → `学而思App诊断工作台`
- meta description → `基于 Mastra 的学而思 App 问题诊断工作台`

- [ ] **Step 2: 冒烟**

确认侧栏与浏览器标题文案正确；打开含 `#` / 表格 / 代码块的历史助手消息可见预览而非源码。
