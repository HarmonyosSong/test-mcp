import type { AiTraceOrEventDetail, AiTraceStep, AiTraceSummary, AiTraceTool } from '../../types';

/** AI 调试导出：把会话的全部轮次 trace 组装成可读文本 / JSON 下载，用于线上问题排查。
 *  注意：本文件被 node --test（--experimental-strip-types）直接执行，只能 import type——
 *  值导入会被 Node 按严格 ESM 解析（../../types 无扩展名解析失败），事件判别因此内联。 */

export interface TraceExportEntry {
  summary: AiTraceSummary;
  detail: AiTraceOrEventDetail;
}

/** 步骤 token 用量：输入（新内容 / 缓存命中）与输出。与调试面板同一口径。 */
export function formatUsage(usage?: AiTraceStep['usage']): string | null {
  if (!usage || usage.inputTokens == null) return null;
  const cached = usage.inputDetails?.cacheRead ?? 0;
  const fresh = usage.inputDetails?.text;
  const input = `输入 ${usage.inputTokens.toLocaleString()}`;
  const freshPart = fresh != null ? `（新 ${fresh.toLocaleString()}${cached ? `，缓存 ${cached.toLocaleString()}` : ''}）` : '';
  const output = usage.outputTokens != null ? ` / 输出 ${usage.outputTokens.toLocaleString()}` : '';
  return `${input}${freshPart}${output} tok`;
}

function toolBlock(tool: AiTraceTool): string[] {
  const status = tool.success === true ? ' ✓' : tool.success === false ? ' ✗' : '';
  const duration = tool.duration_ms != null ? ` · ${Math.round(tool.duration_ms)}ms` : '';
  const lines = [`#### 工具 ${tool.name}${status}${duration}`];
  if (tool.input_preview) lines.push('', '入参：', '```', tool.input_preview, '```');
  const output = tool.error ?? tool.output_preview;
  if (output) lines.push('', tool.error ? '错误：' : '返回：', '```', output, '```');
  return lines;
}

function stepBlock(step: AiTraceStep): string[] {
  const head = [`### 步骤 ${step.step_index}`];
  const meta: string[] = [];
  if (step.duration_ms != null) meta.push(`${Math.round(step.duration_ms)}ms`);
  if (step.finish_reason) meta.push(step.finish_reason);
  const usage = formatUsage(step.usage);
  if (usage) meta.push(usage);
  if (meta.length) head.push(`> ${meta.join(' · ')}`);
  if (step.thinking_text) head.push('', '思考：', '```', step.thinking_text, '```');
  if (step.model_text) head.push('', '模型输出：', '```', step.model_text, '```');
  for (const tool of step.tools) head.push('', ...toolBlock(tool));
  return head;
}

/** 组装 Markdown：会话信息 + 每轮的用户输入/最终回答/逐步工具明细。 */
export function tracesToMarkdown(conversationId: string, entries: TraceExportEntry[]): string {
  const lines = [
    `# AI 调试导出`,
    '',
    `- 会话：${conversationId}`,
    `- 导出时间：${new Date().toISOString()}`,
    `- 轮次：${entries.length}（按时间倒序）`,
  ];
  for (const { summary, detail } of entries) {
    lines.push('', '---', '');
    // 时间线事件（协查发起/回执等编排事实）：不是模型轮，紧凑成一小节。
    if (detail.entry_type === 'event') {
      lines.push(`## 事件 ${summary.ts} · ${detail.title}（${detail.kind}）`);
      if (detail.detail) lines.push('', '```', detail.detail, '```');
      if (detail.data && Object.keys(detail.data).length > 0) {
        lines.push('', '```json', JSON.stringify(detail.data, null, 2), '```');
      }
      continue;
    }
    lines.push(`## 轮次 ${summary.ts}（${summary.trace_id}）`);
    if (detail.model) lines.push(`- 模型：${detail.model}`);
    const meta = summary.summary;
    if (meta) {
      lines.push(
        `- 概览：${meta.steps ?? 0} 步 · ${meta.tool_calls ?? 0} 次工具` +
          (meta.duration_ms != null ? ` · ${Math.round(meta.duration_ms / 1000)}s` : ''),
      );
    }
    if (detail.user_input) lines.push('', '### 用户输入', '', '```', detail.user_input, '```');
    if (detail.final_answer) lines.push('', '### 最终回答', '', '```', detail.final_answer, '```');
    for (const step of detail.steps) lines.push('', ...stepBlock(step));
    for (const tool of detail.orphan_tools ?? []) {
      lines.push('', '#### （未归属步骤）' + tool.name, ...toolBlock(tool).slice(1));
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 触发浏览器下载。 */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
