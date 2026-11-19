# Mastra 按会话观测文件（试用版）

## Goal

用官方 Observability 管线，把 Agent/模型/工具 span **按会话**写成精简 JSON，终端安静，便于本地翻看。

## Layout

```text
<data-dir>/observability/
  conversations/<YYYY-MM-DD>_<HH-MM-SS>_<conversation_id>/
    manifest.jsonl          # 每轮一条索引
    traces/<本地时间>_<trace短号>.json   # 例：2026-11-12_09-51-30_895c4437b708.json
```

目录名 = **年月日_时分秒_会话ID**，例 `2026-11-19_11-16-14_conv-1408593cfb`：

- 时分秒取**会话创建时刻**，同一会话的每一轮 trace 都落进同一个目录（不会按天/按轮拆开）。
- 目录名后缀是会话 ID，`sort` 的字典序即会话先后顺序。
- 历史旧格式 `<YYYY-MM-DD>_<conversation_id>` 会在 Runtime 启动时按目录内最早 trace 的时刻
  自动升级成新命名；会话面板读取端兼容两种命名，同会话并存时取最近写入的目录。


## 每份 trace JSON 含什么（schema_version 2）

- `user_input` / `final_answer`：用户原话与最终回复（默认尽量全文）
- `started_at` / `captured_at`：整轮起止墙钟时间（ISO）
- `steps[]`：按模型轮次；每轮含 `started_at` / `ended_at`、`model_text`、`finish_reason`、`usage`、`tools[]`
- `tools[]`：按 `started_at` 排序；每项含 `started_at` / `ended_at` / `duration_ms`
- `summary`：总耗时、轮次数、工具次数、噪音省略数
- **默认丢弃噪音**：`processor_run`、`mapping`、`model_chunk`；不再输出平铺 `spans[]`
- 正文默认不截断（`PREVIEW_CHARS=0`）；仅保留约 2MB/字段硬顶；需要截断时设正整数

## 开关

- `HARMONY_AGENT_MASTRA_OBSERVABILITY_CONSOLE` 默认 true（名字历史兼容，实际主落文件）
- `HARMONY_AGENT_MASTRA_OBSERVABILITY_DIR` 可选覆盖根目录

## 说明

- 管线：官方 `Observability` + `SensitiveDataFilter`
- 落盘布局/摘要：产品侧 `ConversationSpanFileExporter`（继承官方 `BaseExporter`）
- 不写 knowledge JSONL/cases，不上观测 DB
