# Mastra 按会话观测文件（试用版）

## Goal

用官方 Observability 管线，把 Agent/模型/工具 span **按会话**写成精简 JSON，终端安静，便于本地翻看。

## Layout

```text
<data-dir>/observability/
  conversations/<conversation_id>/
    manifest.jsonl          # 每轮一条索引
    traces/<本地时间>_<trace短号>.json   # 例：2026-11-12_09-51-30_895c4437b708.json
```


## 每份 trace JSON 含什么（schema_version 2）

- `user_input` / `final_answer`：用户原话与最终回复（默认尽量全文）
- `steps[]`：按模型轮次；每轮含 `model_text`、`finish_reason`、`usage`、`tools[]`
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
