import { appendFile, chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TracingEvent } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';

/** 0 = keep full text (recommended for local debugging). */
const DEFAULT_CONTENT_LIMIT = 0;
/** Hard ceiling even when "unlimited", to avoid pathological multi‑MB tool dumps. */
const ABSOLUTE_CONTENT_CEILING = 2_000_000;
const ATTR_LIMIT = 2_000;

/** Framework noise: not useful for diagnosing agent flow. */
const NOISE_SPAN_TYPES = new Set<string>([
  SpanType.MODEL_CHUNK,
  SpanType.PROCESSOR_RUN,
  'mapping',
]);

/** Kept for step assembly; omitted from the final JSON as redundant with steps[]. */
const INTERNAL_KEEP_TYPES = new Set<string>([
  SpanType.AGENT_RUN,
  SpanType.MODEL_STEP,
  SpanType.MODEL_INFERENCE,
  SpanType.MODEL_GENERATION,
  SpanType.TOOL_CALL,
  SpanType.MCP_TOOL_CALL,
]);

type RawSpan = {
  type: string;
  name: string;
  id: string;
  parent_span_id?: string;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  input?: unknown;
  output?: unknown;
  error?: string;
  attributes?: Record<string, unknown>;
};

type TraceBuffer = {
  spans: RawSpan[];
  noiseOmitted: number;
  conversationId: string;
  messageId: string | null;
  phase: string | null;
  startedAt: string;
};

type FlowTool = {
  name: string;
  kind: 'tool' | 'mcp_tool';
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  success: boolean | null;
  input_preview?: string;
  output_preview?: string;
  error?: string;
};

type FlowStep = {
  step_index: number;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  model_text?: string;
  finish_reason?: string;
  usage?: unknown;
  time_to_first_token_ms?: number | null;
  tools: FlowTool[];
};

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 120) || 'unknown';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar date for conversation dirs, e.g. 2026-11-13. */
export function formatLocalDate(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local wall-clock stamp for filenames, e.g. 2026-11-12_09-51-30. */
function formatLocalStamp(date = new Date()): string {
  return [
    formatLocalDate(date),
    `${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`,
  ].join('_');
}

/** Date-prefixed folder so daily traces sort together: 2026-11-13_conv-xxx */
export function conversationObservabilityDirName(conversationId: string, date = new Date()): string {
  return `${formatLocalDate(date)}_${safeId(conversationId)}`;
}

/**
 * 按会话 ID 定位 trace 目录（目录带日期前缀，需后缀匹配）。
 * 仅供调试面板读取已落盘 trace；找不到返回 null。
 */
export async function findConversationObservabilityDir(
  rootDir: string,
  conversationId: string,
): Promise<string | null> {
  const suffix = `_${safeId(conversationId)}`;
  let entries: string[];
  try {
    entries = await readdir(join(rootDir, 'conversations'));
  } catch {
    return null;
  }
  const matches = entries.filter((entry) => entry.endsWith(suffix)).sort();
  const latest = matches.at(-1);
  return latest ? join(rootDir, 'conversations', latest) : null;
}

function preview(value: unknown, limit = DEFAULT_CONTENT_LIMIT): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return undefined;
  const effective =
    !limit || limit <= 0
      ? ABSOLUTE_CONTENT_CEILING
      : Math.min(limit, ABSOLUTE_CONTENT_CEILING);
  return text.length <= effective ? text : `${text.slice(0, effective - 1)}…`;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tryParseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractUserInput(agentRun: RawSpan | undefined, limit: number): string | undefined {
  if (!agentRun?.input) return undefined;
  if (typeof agentRun.input === 'string') return preview(agentRun.input, limit);
  if (Array.isArray(agentRun.input)) {
    const user = [...agentRun.input].reverse().find(
      (item) => item && typeof item === 'object' && (item as { role?: string }).role === 'user',
    ) as { content?: unknown } | undefined;
    if (user?.content !== undefined) return preview(user.content, limit);
  }
  if (typeof agentRun.input === 'object' && agentRun.input !== null) {
    const record = agentRun.input as Record<string, unknown>;
    if (typeof record.prompt === 'string') return preview(record.prompt, limit);
    if (Array.isArray(record.messages)) {
      const user = [...record.messages].reverse().find(
        (item) => item && typeof item === 'object' && (item as { role?: string }).role === 'user',
      ) as { content?: unknown } | undefined;
      if (user?.content !== undefined) return preview(user.content, limit);
    }
  }
  return preview(agentRun.input, limit);
}

function extractFinalText(agentRun: RawSpan | undefined, limit: number): string | undefined {
  if (!agentRun?.output) return undefined;
  if (typeof agentRun.output === 'string') return preview(agentRun.output, limit);
  if (typeof agentRun.output === 'object' && agentRun.output !== null) {
    const record = agentRun.output as Record<string, unknown>;
    if (typeof record.text === 'string') return preview(record.text, limit);
  }
  return preview(agentRun.output, limit);
}

function extractModelText(output: unknown, limit: number): string | undefined {
  if (!output) return undefined;
  if (typeof output === 'string') {
    const parsed = tryParseJson(output);
    if (parsed && typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
      return preview((parsed as { text?: unknown }).text, limit);
    }
    return preview(output, limit);
  }
  if (typeof output === 'object' && output !== null && 'text' in output) {
    return preview((output as { text?: unknown }).text, limit);
  }
  return undefined;
}

function toolDisplayName(span: RawSpan): string {
  const fromAttrs = span.attributes?.toolName ?? span.attributes?.name;
  if (typeof fromAttrs === 'string' && fromAttrs.trim()) return fromAttrs.trim();
  const match = /(?:mcp_tool|tool):\s*'([^']+)'/.exec(span.name);
  if (match?.[1]) return match[1];
  return span.name;
}

function attrFlag(attributes: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = attributes?.[key];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function parseUsage(attributes: Record<string, unknown> | undefined): unknown {
  const raw = attributes?.usage;
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return tryParseJson(raw) ?? raw;
  return raw;
}

function toIso(value: Date | string | number | null | undefined): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function timeMs(iso: string | null): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function compareByStart(a: { started_at: string | null; name?: string }, b: { started_at: string | null; name?: string }): number {
  const delta = timeMs(a.started_at) - timeMs(b.started_at);
  if (delta !== 0) return delta;
  return (a.name ?? '').localeCompare(b.name ?? '');
}

function toFlowTool(tool: RawSpan, contentLimit: number): FlowTool {
  return {
    name: toolDisplayName(tool),
    kind: tool.type === SpanType.MCP_TOOL_CALL ? 'mcp_tool' : 'tool',
    duration_ms: tool.duration_ms,
    started_at: tool.started_at,
    ended_at: tool.ended_at,
    success: attrFlag(tool.attributes, 'success'),
    input_preview: preview(tool.input, contentLimit),
    output_preview: preview(tool.output, contentLimit),
    error: tool.error,
  };
}

function buildFlow(spans: RawSpan[], contentLimit: number): {
  user_input?: string;
  final_answer?: string;
  steps: FlowStep[];
  orphan_tools: FlowTool[];
} {
  const agentRun = spans.find((item) => item.type === SpanType.AGENT_RUN);
  const stepsRaw = spans
    .filter((item) => item.type === SpanType.MODEL_STEP)
    .sort((a, b) => {
      const ai = Number(a.attributes?.stepIndex ?? Number.MAX_SAFE_INTEGER);
      const bi = Number(b.attributes?.stepIndex ?? Number.MAX_SAFE_INTEGER);
      if (ai !== bi) return ai - bi;
      const byTime = compareByStart(a, b);
      if (byTime !== 0) return byTime;
      return a.name.localeCompare(b.name);
    });

  const tools = spans.filter(
    (item) => item.type === SpanType.TOOL_CALL || item.type === SpanType.MCP_TOOL_CALL,
  );
  const usedToolIds = new Set<string>();

  const steps: FlowStep[] = stepsRaw.map((step, index) => {
    const stepTools = tools
      .filter((tool) => tool.parent_span_id === step.id)
      .map((tool) => {
        usedToolIds.add(tool.id);
        return toFlowTool(tool, contentLimit);
      })
      .sort(compareByStart);

    const inference = spans.find(
      (item) => item.type === SpanType.MODEL_INFERENCE && item.parent_span_id === step.id,
    );
    const finishReason =
      (typeof step.attributes?.finishReason === 'string' && step.attributes.finishReason)
      || (typeof inference?.attributes?.finishReason === 'string' && inference.attributes.finishReason)
      || undefined;
    const ttftRaw = step.attributes?.timeToFirstTokenMs ?? inference?.attributes?.timeToFirstTokenMs;
    const ttft = ttftRaw === undefined || ttftRaw === null ? null : Number(ttftRaw);

    return {
      step_index: Number.isFinite(Number(step.attributes?.stepIndex))
        ? Number(step.attributes?.stepIndex)
        : index,
      duration_ms: step.duration_ms,
      started_at: step.started_at,
      ended_at: step.ended_at,
      model_text: extractModelText(step.output, contentLimit),
      finish_reason: finishReason,
      usage: parseUsage(step.attributes) ?? parseUsage(inference?.attributes),
      time_to_first_token_ms: Number.isFinite(ttft) ? ttft : null,
      tools: stepTools,
    };
  });

  const orphan_tools = tools
    .filter((tool) => !usedToolIds.has(tool.id))
    .map((tool) => toFlowTool(tool, contentLimit))
    .sort(compareByStart);

  return {
    user_input: extractUserInput(agentRun, contentLimit),
    final_answer: extractFinalText(agentRun, contentLimit),
    steps,
    orphan_tools,
  };
}

/**
 * Writes one readable per-conversation flow JSON per agent run.
 * Drops processor/mapping/chunk noise and groups tools under model steps.
 */
export class ConversationSpanFileExporter extends BaseExporter {
  name = 'troubleshoot-conversation-span-file-exporter';
  readonly #rootDir: string;
  readonly #contentLimit: number;
  readonly #buffers = new Map<string, TraceBuffer>();

  constructor(rootDir: string, contentLimit: number = DEFAULT_CONTENT_LIMIT) {
    super();
    this.#rootDir = rootDir;
    this.#contentLimit = contentLimit;
  }

  async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type !== 'span_ended' && event.type !== 'span_started') return;
    const span = event.exportedSpan;
    const metadata = (span.metadata ?? {}) as Record<string, unknown>;
    const conversationId = metadataString(metadata, 'conversation_id') ?? 'unknown';
    const messageId = metadataString(metadata, 'message_id');
    const phase = metadataString(metadata, 'phase');

    let buffer = this.#buffers.get(span.traceId);
    if (!buffer) {
      buffer = {
        spans: [],
        noiseOmitted: 0,
        conversationId,
        messageId,
        phase,
        startedAt: new Date().toISOString(),
      };
      this.#buffers.set(span.traceId, buffer);
    } else {
      if (conversationId !== 'unknown') buffer.conversationId = conversationId;
      if (messageId) buffer.messageId = messageId;
      if (phase) buffer.phase = phase;
    }

    if (event.type === 'span_started') return;

    const type = String(span.type);
    if (NOISE_SPAN_TYPES.has(type) || !INTERNAL_KEEP_TYPES.has(type)) {
      buffer.noiseOmitted += 1;
    } else {
      const startedAt = toIso(span.startTime);
      const endedAt = toIso(span.endTime);
      const durationMs =
        startedAt && endedAt
          ? Date.parse(endedAt) - Date.parse(startedAt)
          : span.endTime instanceof Date && span.startTime instanceof Date
            ? span.endTime.getTime() - span.startTime.getTime()
            : null;
      if (startedAt && (!buffer.startedAt || startedAt < buffer.startedAt)) {
        buffer.startedAt = startedAt;
      }
      buffer.spans.push({
        type,
        name: span.name,
        id: span.id,
        parent_span_id: span.parentSpanId,
        duration_ms: durationMs,
        started_at: startedAt,
        ended_at: endedAt,
        input: span.input,
        output: span.output,
        error: span.errorInfo
          ? preview(span.errorInfo.message ?? span.errorInfo, Math.max(ATTR_LIMIT, this.#contentLimit || ATTR_LIMIT))
          : undefined,
        attributes: (span.attributes ?? undefined) as Record<string, unknown> | undefined,
      });
    }

    if (type === SpanType.AGENT_RUN) {
      await this.#flushTrace(span.traceId, buffer);
      this.#buffers.delete(span.traceId);
    }
  }

  async #flushTrace(traceId: string, buffer: TraceBuffer): Promise<void> {
    const conversationDir = join(
      this.#rootDir,
      'conversations',
      conversationObservabilityDirName(buffer.conversationId),
    );
    const tracesDir = join(conversationDir, 'traces');
    await mkdir(tracesDir, { recursive: true, mode: 0o700 });
    await chmod(conversationDir, 0o700).catch(() => undefined);
    await chmod(tracesDir, 0o700).catch(() => undefined);

    const stamp = formatLocalStamp();
    const fileName = `${stamp}_${safeId(traceId.slice(0, 12))}.json`;
    const filePath = join(tracesDir, fileName);

    const agentRun = buffer.spans.find((item) => item.type === SpanType.AGENT_RUN);
    const flow = buildFlow(buffer.spans, this.#contentLimit);
    const toolCount = flow.steps.reduce((sum, step) => sum + step.tools.length, 0) + flow.orphan_tools.length;

    const payload = {
      schema_version: 2,
      conversation_id: buffer.conversationId,
      message_id: buffer.messageId,
      phase: buffer.phase,
      trace_id: traceId,
      captured_at: new Date().toISOString(),
      started_at: buffer.startedAt,
      model: typeof agentRun?.attributes?.model === 'string' ? agentRun.attributes.model : null,
      summary: {
        duration_ms: agentRun?.duration_ms ?? null,
        steps: flow.steps.length,
        tool_calls: toolCount,
        noise_spans_omitted: buffer.noiseOmitted,
      },
      user_input: flow.user_input,
      final_answer: flow.final_answer,
      steps: flow.steps,
      ...(flow.orphan_tools.length > 0 ? { orphan_tools: flow.orphan_tools } : {}),
    };

    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(filePath, 0o600);

    const manifestPath = join(conversationDir, 'manifest.jsonl');
    await appendFile(
      manifestPath,
      `${JSON.stringify({
        ts: payload.captured_at,
        trace_id: traceId,
        message_id: buffer.messageId,
        phase: buffer.phase,
        file: `traces/${fileName}`,
        summary: payload.summary,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(manifestPath, 0o600).catch(() => undefined);
  }
}
