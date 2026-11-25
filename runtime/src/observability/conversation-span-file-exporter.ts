import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TracingEvent } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';

/**
 * 思考（reasoning）侧通道。
 * Mastra 1.81 的 DurableAgent 关闭 MODEL_STEP span 时 output 只保留
 * { text, toolCalls }，reasoning 内容在 span 层被丢弃（usage 里仍有
 * reasoning token 计数）。fullStream 的 reasoning-delta chunk 是完整的，
 * 由 DiagnosisAgent 按步骤累积后写入本注册表；exporter 在 trace 落盘时
 * 按会话 FIFO 对齐合并进 steps[].thinking_text。
 * 注册表按会话封顶，无 exporter 的环境（测试）不会无限增长。
 */
const THINKING_QUEUE_CAP = 8;
const thinkingByConversation = new Map<string, string[][]>();

export function recordRoundThinking(conversationId: string, steps: string[]): void {
  const queue = thinkingByConversation.get(conversationId) ?? [];
  queue.push(steps);
  if (queue.length > THINKING_QUEUE_CAP) queue.shift();
  thinkingByConversation.set(conversationId, queue);
}

function takeRoundThinking(conversationId: string): string[] | undefined {
  const queue = thinkingByConversation.get(conversationId);
  if (!queue || queue.length === 0) return undefined;
  const entry = queue.shift();
  if (queue.length === 0) thinkingByConversation.delete(conversationId);
  return entry;
}

// ———— 会话时间线事件侧通道 ————
//
// 观测面不能只覆盖模型轮：协查发起/回执、兜底绑定、分析轮跳过这类确定性编排
// 不产生 span，主轮 trace 封盘后就成了盲区。这里提供一条与 trace 并行的
// 事件通道——调用方给事实，本模块负责落到会话观测目录的 events.jsonl，
// 调试面板把 trace 与事件按时间合并渲染成会话时间线。

/** 一条会话时间线事件（events.jsonl 的一行）。 */
export interface ConversationTimelineEvent {
  event_id: string;
  /** 事件种类：compass_followup_sent / compass_followup_settled / followup_source_bound / … */
  kind: string;
  /** 事件发生的真实时刻（ISO）；落盘顺序不代表发生顺序，面板按它排序。 */
  at: string;
  /** 面板一行标题。 */
  title: string;
  /** 长文本详情（协查结论全文、分析正文等）。 */
  detail?: string;
  /** 结构化补充（task_id、wait_ms、跳过原因等）。 */
  data?: Record<string, unknown>;
}

let eventSinkRootDir: string | null = null;

/** 注册事件落盘根目录（observability 根）；由 Mastra 观测装配处调用，进程内一次。 */
export function registerConversationEventSink(rootDir: string): void {
  eventSinkRootDir = rootDir;
}

/**
 * 追加一条会话时间线事件。best-effort：未注册 sink（测试环境）或落盘失败都不抛错，
 * 绝不影响业务流程。目录解析与 trace 同一套规则：已有会话目录复用，没有才按会话创建时刻新建。
 */
export async function recordConversationEvent(
  conversationId: string,
  conversationCreatedAt: string | null | undefined,
  input: {
    kind: string;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
    /** 事件的实际发生时刻；缺省为调用时刻。 */
    at?: string;
  },
): Promise<void> {
  if (!eventSinkRootDir) return;
  try {
    const conversationsRoot = join(eventSinkRootDir, 'conversations');
    const conversationDir = await resolveConversationObservabilityDir(
      conversationsRoot,
      conversationId,
      conversationCreatedAt ? new Date(conversationCreatedAt) : new Date(),
    );
    await mkdir(conversationDir, { recursive: true, mode: 0o700 });
    await chmod(conversationDir, 0o700).catch(() => undefined);
    const event: ConversationTimelineEvent = {
      event_id: `evt-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      kind: input.kind,
      at: input.at ?? new Date().toISOString(),
      title: input.title,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    };
    const eventsPath = join(conversationDir, 'events.jsonl');
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(eventsPath, 0o600).catch(() => undefined);
  } catch {
    // 观测事件落盘失败不拖累业务流程。
  }
}

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
  /** 会话创建时刻：会话观测目录以它命名，保证多轮 trace 落到同一目录。 */
  conversationCreatedAt: Date | null;
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
  /** 推理（thinking）文本：模型产出 reasoning 时落盘，非推理模型缺省。 */
  thinking_text?: string;
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

/** Local wall-clock stamp, e.g. 2026-11-12_09-51-30 (年月日_时分秒). */
export function formatLocalTimestamp(date = new Date()): string {
  return [
    formatLocalDate(date),
    `${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`,
  ].join('_');
}

/**
 * 会话观测目录名：`年月日_时分秒_会话ID`，例 `2026-11-19_11-16-14_conv-1408593cfb`。
 * 时刻取**会话创建时刻**（同一会话的多轮 trace 始终落进同一目录），
 * 同一秒内多个会话靠 ID 后缀区分，字典序即会话先后顺序。
 */
export function conversationObservabilityDirName(conversationId: string, date = new Date()): string {
  return `${formatLocalTimestamp(date)}_${safeId(conversationId)}`;
}

/** 目录名的可排序键；旧格式（仅日期）视为当天 00:00:00，便于与新格式统一比较。 */
function observabilityDirSortKey(dirName: string): string {
  const withTime = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_/.exec(dirName);
  if (withTime) return `${withTime[1]}_${withTime[2]}`;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})_/.exec(dirName);
  if (dateOnly) return `${dateOnly[1]}_00-00-00`;
  return dirName;
}

/** 列出该会话已有的观测目录名（新旧两种命名都以 `_<会话ID>` 结尾）。 */
async function listConversationDirNames(
  conversationsRoot: string,
  conversationId: string,
): Promise<string[]> {
  const suffix = `_${safeId(conversationId)}`;
  try {
    const entries = await readdir(conversationsRoot);
    return entries.filter((entry) => entry.endsWith(suffix));
  } catch {
    return [];
  }
}

/**
 * 按会话 ID 定位 trace 目录（目录名以 `_<会话ID>` 结尾，含旧格式）。
 * 仅供调试面板读取已落盘 trace；多个候选时取最近写入的那个；找不到返回 null。
 */
export async function findConversationObservabilityDir(
  rootDir: string,
  conversationId: string,
): Promise<string | null> {
  const conversationsRoot = join(rootDir, 'conversations');
  const matches = await listConversationDirNames(conversationsRoot, conversationId);
  const first = matches[0];
  if (first === undefined) return null;
  if (matches.length === 1) return join(conversationsRoot, first);

  // 同一会话新旧目录并存时，以最近写入的目录为准。
  const scored = await Promise.all(matches.map(async (entry) => {
    const path = join(conversationsRoot, entry);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return { entry, mtimeMs, key: observabilityDirSortKey(entry) };
  }));
  scored.sort((a, b) => a.mtimeMs - b.mtimeMs || a.key.localeCompare(b.key));
  return join(conversationsRoot, scored.at(-1)!.entry);
}

/**
 * 落盘目录：同一会话已有目录就复用（新旧命名都算），保证同一会话的 trace 不会
 * 因为命名规则变化被拆到两个目录；没有才按会话创建时刻新建。
 * 历史旧命名目录由启动时的 `migrateLegacyObservabilityDirs` 统一升级。
 */
async function resolveConversationObservabilityDir(
  conversationsRoot: string,
  conversationId: string,
  createdAt: Date,
): Promise<string> {
  const existing = await listConversationDirNames(conversationsRoot, conversationId);
  if (existing.length > 0) {
    existing.sort((a, b) => observabilityDirSortKey(a).localeCompare(observabilityDirSortKey(b)));
    return join(conversationsRoot, existing.at(-1)!);
  }
  return join(conversationsRoot, conversationObservabilityDirName(conversationId, createdAt));
}

/** 新命名目录名：`年月日_时分秒_会话ID`。 */
function isCurrentDirName(dirName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/.test(dirName);
}

/**
 * 启动时把历史观测目录统一升级为 `年月日_时分秒_会话ID`。
 * 会话 ID 从旧目录名后缀取，时分秒用目录内最早 trace 的时刻
 * （trace 文件名就带 `年月日_时分秒`，比文件时间更准）；拿不到则保留原名。
 * 逐个 best-effort，失败（目标已存在/权限）就跳过，不阻断启动。
 * 返回升级数量，便于调用方打日志。
 */
export async function migrateLegacyObservabilityDirs(rootDir: string): Promise<number> {
  const conversationsRoot = join(rootDir, 'conversations');
  let entries: string[];
  try {
    entries = await readdir(conversationsRoot);
  } catch {
    return 0;
  }
  let upgraded = 0;
  for (const entry of entries) {
    if (isCurrentDirName(entry)) continue;
    const dateOnly = /^(\d{4}-\d{2}-\d{2})_(.+)$/.exec(entry);
    if (!dateOnly) continue;
    const legacyPath = join(conversationsRoot, entry);
    const upgradedAt = await earliestTraceTime(legacyPath);
    // 没有 trace 就无从得知时分秒，保持原名（读取端仍按后缀匹配）。
    if (!upgradedAt) continue;
    const target = conversationObservabilityDirName(dateOnly[2]!, upgradedAt);
    if (target === entry) continue;
    try {
      await rename(legacyPath, join(conversationsRoot, target));
      upgraded += 1;
    } catch {
      // 目标已存在或权限受限：保留旧目录，读取端仍能按后缀定位。
    }
  }
  return upgraded;
}

/** 目录内最早 trace 的落盘时刻（优先取文件名里的 `年月日_时分秒`，其次文件创建时间）。 */
async function earliestTraceTime(conversationDir: string): Promise<Date | null> {
  const tracesDir = join(conversationDir, 'traces');
  let names: string[];
  try {
    names = await readdir(tracesDir);
  } catch {
    return null;
  }
  const stamps = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (stamps.length > 0) {
    return new Date(Math.min(...stamps.map((date) => date.getTime())));
  }

  const times = (await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    try {
      const info = await stat(join(tracesDir, name));
      return info.birthtimeMs || info.mtimeMs;
    } catch {
      return 0;
    }
  }))).filter((value) => value > 0);
  if (times.length === 0) return null;
  return new Date(Math.min(...times));
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

/** 宽松解析 ISO 时间串；无效或缺失返回 null（调用方回落到默认时刻）。 */
function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

/**
 * 推理（thinking）文本：AI SDK step 输出里的 reasoningText 优先，
 * 缺时把 reasoning 明细（{ payload: { text } } 或 { text }）顺序拼接。
 * 非推理模型没有这些字段，返回 undefined（面板里就不渲染思考行）。
 */
function extractThinkingText(output: unknown, limit: number): string | undefined {
  if (!output) return undefined;
  let source: unknown;
  if (typeof output === 'string') {
    source = tryParseJson(output);
  } else if (typeof output === 'object') {
    source = output;
  }
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  if (typeof record.reasoningText === 'string' && record.reasoningText.trim()) {
    return preview(record.reasoningText, limit);
  }
  if (Array.isArray(record.reasoning)) {
    const text = record.reasoning
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const detail = part as { payload?: { text?: unknown }; text?: unknown };
        const value = detail.payload?.text ?? detail.text;
        return typeof value === 'string' ? value : '';
      })
      .join('')
      .trim();
    if (text) return preview(text, limit);
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
      thinking_text: extractThinkingText(step.output, contentLimit),
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
    const conversationCreatedAt = parseDate(metadataString(metadata, 'conversation_created_at'));

    let buffer = this.#buffers.get(span.traceId);
    if (!buffer) {
      buffer = {
        spans: [],
        noiseOmitted: 0,
        conversationId,
        messageId,
        phase,
        startedAt: new Date().toISOString(),
        conversationCreatedAt,
      };
      this.#buffers.set(span.traceId, buffer);
    } else {
      if (conversationId !== 'unknown') buffer.conversationId = conversationId;
      if (messageId) buffer.messageId = messageId;
      if (phase) buffer.phase = phase;
      if (conversationCreatedAt) buffer.conversationCreatedAt = conversationCreatedAt;
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
    const conversationsRoot = join(this.#rootDir, 'conversations');
    const conversationDir = await resolveConversationObservabilityDir(
      conversationsRoot,
      buffer.conversationId,
      buffer.conversationCreatedAt ?? new Date(),
    );
    const tracesDir = join(conversationDir, 'traces');
    await mkdir(tracesDir, { recursive: true, mode: 0o700 });
    await chmod(conversationDir, 0o700).catch(() => undefined);
    await chmod(tracesDir, 0o700).catch(() => undefined);

    const stamp = formatLocalTimestamp();
    const fileName = `${stamp}_${safeId(traceId.slice(0, 12))}.json`;
    const filePath = join(tracesDir, fileName);

    const agentRun = buffer.spans.find((item) => item.type === SpanType.AGENT_RUN);
    const flow = buildFlow(buffer.spans, this.#contentLimit);
    // 合并思考侧通道：span 层没有 reasoning，用流内捕获的按步骤思考补齐。
    const thinking = takeRoundThinking(buffer.conversationId);
    if (thinking) {
      flow.steps.forEach((step, index) => {
        if (!step.thinking_text && thinking[index]) step.thinking_text = thinking[index];
      });
    }
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
