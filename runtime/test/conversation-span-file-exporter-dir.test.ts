import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SpanType } from '@mastra/core/observability';

import {
  ConversationSpanFileExporter,
  conversationObservabilityDirName,
  findConversationObservabilityDir,
  migrateLegacyObservabilityDirs,
} from '../src/observability/conversation-span-file-exporter.js';

/** 一轮最小的 agent run spans：tool → step → agent，触发一次 trace 落盘。 */
async function emitTrace(
  exporter: ConversationSpanFileExporter,
  options: {
    conversationId: string;
    createdAt: Date;
    traceId: string;
    messageId?: string;
  },
): Promise<void> {
  const meta = {
    conversation_id: options.conversationId,
    conversation_created_at: options.createdAt.toISOString(),
    message_id: options.messageId ?? 'msg-1',
    phase: 'local',
  };
  const base = {
    traceId: options.traceId,
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
}

test('目录名为 年月日_时分秒_会话ID', () => {
  const createdAt = new Date(2026, 10, 19, 11, 16, 14);
  assert.equal(
    conversationObservabilityDirName('conv-1408593cfb', createdAt),
    '2026-11-19_11-16-14_conv-1408593cfb',
  );
});

test('同一会话多轮 trace 始终落进同一个目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obs-multi-'));
  const exporter = new ConversationSpanFileExporter(root);
  const createdAt = new Date(2026, 10, 19, 11, 16, 14);
  const expectedDir = conversationObservabilityDirName('conv-multi', createdAt);

  await emitTrace(exporter, { conversationId: 'conv-multi', createdAt, traceId: 'trace-turn1' });
  await emitTrace(exporter, { conversationId: 'conv-multi', createdAt, traceId: 'trace-turn2' });

  const dirs = await readdir(join(root, 'conversations'));
  assert.deepEqual(dirs, [expectedDir]);
  const traces = await readdir(join(root, 'conversations', expectedDir, 'traces'));
  assert.equal(traces.length, 2);
});

test('旧目录（仅日期）由启动迁移升级为 年月日_时分秒_会话ID，历史 trace 保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obs-legacy-'));
  const conversationsRoot = join(root, 'conversations');
  const legacyName = '2026-11-19_conv-legacy';
  const legacyTraces = join(conversationsRoot, legacyName, 'traces');
  await mkdir(legacyTraces, { recursive: true });
  // trace 文件名自带轮次时刻，迁移时用它补出目录的时分秒。
  await writeFile(join(legacyTraces, '2026-11-19_11-16-14_aaaaaaaaaaaa.json'), '{}', 'utf8');
  await writeFile(join(legacyTraces, '2026-11-19_11-17-14_bbbbbbbbbbbb.json'), '{}', 'utf8');

  assert.equal(await migrateLegacyObservabilityDirs(root), 1);

  const dirs = await readdir(conversationsRoot);
  assert.deepEqual(dirs, ['2026-11-19_11-16-14_conv-legacy']);
  // 历史 trace 全部保留在新目录里。
  const traces = await readdir(join(conversationsRoot, dirs[0]!, 'traces'));
  assert.equal(traces.length, 2);
});

test('迁移幂等：已是新命名或新会话落盘后再迁移都不会改动目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obs-legacy-idempotent-'));
  const exporter = new ConversationSpanFileExporter(root);
  const createdAt = new Date(2026, 10, 19, 14, 3, 7);
  await emitTrace(exporter, { conversationId: 'conv-new', createdAt, traceId: 'trace-new' });

  const before = await readdir(join(root, 'conversations'));
  assert.equal(await migrateLegacyObservabilityDirs(root), 0);
  assert.deepEqual(await readdir(join(root, 'conversations')), before);
});

test('读取端能定位新旧两种目录命名，且优先取最近写入的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obs-find-'));
  const conversationsRoot = join(root, 'conversations');
  const legacyName = '2026-11-18_conv-find';
  const currentName = conversationObservabilityDirName('conv-find', new Date(2026, 10, 19, 9, 30, 0));
  await mkdir(join(conversationsRoot, legacyName, 'traces'), { recursive: true });
  await mkdir(join(conversationsRoot, currentName, 'traces'), { recursive: true });

  assert.equal(
    await findConversationObservabilityDir(root, 'conv-find'),
    join(conversationsRoot, currentName),
  );
  assert.equal(await findConversationObservabilityDir(root, 'conv-absent'), null);
});
