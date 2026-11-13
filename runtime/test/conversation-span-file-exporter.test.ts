import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SpanType } from '@mastra/core/observability';

import {
  ConversationSpanFileExporter,
  conversationObservabilityDirName,
} from '../src/observability/conversation-span-file-exporter.js';

test('writes step-oriented flow JSON and drops processor/mapping/chunk noise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obs-conv-'));
  const exporter = new ConversationSpanFileExporter(root);
  const convDir = conversationObservabilityDirName('conv-demo');

  const meta = {
    conversation_id: 'conv-demo',
    message_id: 'msg-1',
    phase: 'local',
  };
  const base = {
    traceId: 'trace-abc123def456',
    startTime: new Date(0),
    endTime: new Date(100),
    isEvent: false,
    isValid: true,
    metadata: meta,
  };

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'proc-1',
      name: 'llm request processor: provider-history-compat',
      type: SpanType.PROCESSOR_RUN,
      input: { prompt: [{ role: 'system', content: 'long system' }] },
    },
  } as never);

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'chunk-1',
      name: 'chunk',
      type: SpanType.MODEL_CHUNK,
      input: 'x'.repeat(200),
    },
  } as never);

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'map-1',
      name: "tool output mapping: 'lookup_issue'",
      type: 'mapping',
      input: { hits: 1 },
    },
  } as never);

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'tool-1',
      parentSpanId: 'step-0',
      name: "mcp_tool: 'lookup_issue' on 'knowledge'",
      type: SpanType.MCP_TOOL_CALL,
      input: { query: '英语绘本阅读排行榜接口', end: 'harmony' },
      output: { hits: [{ name: 'cloudlearn-terms-vs-user-words' }] },
      attributes: { success: 'true' },
      endTime: new Date(40),
    },
  } as never);

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'step-0',
      parentSpanId: 'gen-1',
      name: 'step: 0',
      type: SpanType.MODEL_STEP,
      output: {
        text: '我先查一下知识库。',
        toolCalls: [{ toolName: 'lookup_issue' }],
      },
      attributes: {
        stepIndex: '0',
        finishReason: 'tool-calls',
        usage: '{"inputTokens":100,"outputTokens":20}',
        timeToFirstTokenMs: '200',
      },
      endTime: new Date(50),
    },
  } as never);

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'step-1',
      parentSpanId: 'gen-1',
      name: 'step: 1',
      type: SpanType.MODEL_STEP,
      output: { text: '知识库没有该接口说明。' },
      attributes: {
        stepIndex: '1',
        finishReason: 'stop',
        usage: '{"inputTokens":200,"outputTokens":40}',
      },
      endTime: new Date(90),
    },
  } as never);

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'agent-1',
      name: "agent run: 'harmony-diagnosis'",
      type: SpanType.AGENT_RUN,
      input: [{ role: 'user', content: '请查询下英语绘本阅读排行榜的接口' }],
      output: { text: '知识库没有该接口说明。' },
      attributes: { model: 'deepseek-v4.1-flash' },
      endTime: new Date(120),
    },
  } as never);

  assert.match(convDir, /^\d{4}-\d{2}-\d{2}_conv-demo$/);
  const tracesDir = join(root, 'conversations', convDir, 'traces');
  const files = await readdir(tracesDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-zA-Z0-9._-]+\.json$/);
  assert.ok(!files[0]!.includes('T'));
  assert.ok(!files[0]!.includes('Z'));
  const body = JSON.parse(await readFile(join(tracesDir, files[0]!), 'utf8')) as {
    schema_version: number;
    user_input?: string;
    final_answer?: string;
    summary: { steps: number; tool_calls: number; noise_spans_omitted: number };
    steps: Array<{
      step_index: number;
      model_text?: string;
      finish_reason?: string;
      tools: Array<{ name: string; input_preview?: string }>;
    }>;
    spans?: unknown;
  };

  assert.equal(body.schema_version, 2);
  assert.equal(body.user_input, '请查询下英语绘本阅读排行榜的接口');
  assert.equal(body.final_answer, '知识库没有该接口说明。');
  assert.equal(body.summary.steps, 2);
  assert.equal(body.summary.tool_calls, 1);
  assert.ok(body.summary.noise_spans_omitted >= 3);
  assert.equal(body.spans, undefined);
  assert.equal(body.steps[0]?.model_text, '我先查一下知识库。');
  assert.equal(body.steps[0]?.finish_reason, 'tool-calls');
  assert.equal(body.steps[0]?.tools[0]?.name, 'lookup_issue');
  assert.match(body.steps[0]?.tools[0]?.input_preview ?? '', /英语绘本阅读排行榜接口/);
  assert.equal(body.steps[1]?.finish_reason, 'stop');
  assert.equal(body.steps[1]?.tools.length, 0);
});

test('keeps long tool output by default (no 500-char truncation)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obs-full-'));
  const exporter = new ConversationSpanFileExporter(root, 0);
  const long = `命中详情:${'A'.repeat(4000)}`;
  const meta = { conversation_id: 'conv-full', message_id: 'msg-2', phase: 'local' };
  const base = {
    traceId: 'trace-full123456',
    startTime: new Date(0),
    endTime: new Date(10),
    isEvent: false,
    isValid: true,
    metadata: meta,
  };

  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'tool-1',
      parentSpanId: 'step-0',
      name: "tool: 'search_knowledge'",
      type: SpanType.TOOL_CALL,
      input: { query: 'x' },
      output: { text: long },
      attributes: { success: 'true' },
    },
  } as never);
  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'step-0',
      name: 'step: 0',
      type: SpanType.MODEL_STEP,
      output: { text: 'ok' },
      attributes: { stepIndex: '0', finishReason: 'stop' },
    },
  } as never);
  await exporter.exportTracingEvent({
    type: 'span_ended',
    exportedSpan: {
      ...base,
      id: 'agent-1',
      name: 'agent run',
      type: SpanType.AGENT_RUN,
      input: [{ role: 'user', content: 'q' }],
      output: { text: 'a' },
    },
  } as never);

  const fullDir = conversationObservabilityDirName('conv-full');
  const file = (await readdir(join(root, 'conversations', fullDir, 'traces')))[0]!;
  const body = JSON.parse(
    await readFile(join(root, 'conversations', fullDir, 'traces', file), 'utf8'),
  ) as { steps: Array<{ tools: Array<{ output_preview?: string }> }> };
  const output = body.steps[0]?.tools[0]?.output_preview ?? '';
  assert.match(output, /命中详情/);
  assert.ok(output.includes('A'.repeat(4000)));
  assert.ok(!output.endsWith('…'));
});
