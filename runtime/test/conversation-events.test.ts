import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  conversationObservabilityDirName,
  findConversationObservabilityDir,
  recordConversationEvent,
  registerConversationEventSink,
  type ConversationTimelineEvent,
} from '../src/observability/conversation-span-file-exporter.js';

// 注意：事件 sink 是模块级全局状态，本文件内的测试顺序即注册顺序。
// node --test 每个测试文件独立子进程，互不污染。

test('未注册 sink 时记录事件是安静 no-op（测试环境兜底）', async () => {
  await recordConversationEvent('conv-nosink', null, { kind: 'k', title: 't' });
  // 不抛错即通过：没有根目录可断言，重点是业务流程绝不被观测拖垮。
});

async function readEvents(root: string, conversationId: string): Promise<ConversationTimelineEvent[]> {
  const dir = await findConversationObservabilityDir(root, conversationId);
  assert.ok(dir, '会话观测目录应存在');
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ConversationTimelineEvent);
}

test('注册 sink 后事件落盘到按会话创建时刻命名的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-events-'));
  try {
    registerConversationEventSink(root);
    const createdAt = '2026-11-24T10:07:31.000Z';
    await recordConversationEvent('conv-evt1', createdAt, {
      kind: 'compass_followup_sent',
      title: '发起服务端协查',
      detail: '请核查订单服务',
      data: { consultation_id: 'c-1' },
      at: '2026-11-24T10:08:35.000Z',
    });

    const expectedDir = conversationObservabilityDirName('conv-evt1', new Date(createdAt));
    const entries = await readdir(join(root, 'conversations'));
    assert.deepEqual(entries, [expectedDir]);

    const events = await readEvents(root, 'conv-evt1');
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.match(event.event_id, /^evt-[0-9a-f]{10}$/);
    assert.equal(event.kind, 'compass_followup_sent');
    assert.equal(event.title, '发起服务端协查');
    assert.equal(event.at, '2026-11-24T10:08:35.000Z');
    assert.equal(event.detail, '请核查订单服务');
    assert.deepEqual(event.data, { consultation_id: 'c-1' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('会话已有 trace 目录时事件复用同一目录，且多条事件按行追加', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-events-reuse-'));
  try {
    registerConversationEventSink(root);
    // 模拟 trace 已落盘的会话目录（命名时刻与事件调用时刻不同）。
    const existing = join(root, 'conversations', '2026-11-24_18-07-31_conv-evt2');
    await mkdir(join(existing, 'traces'), { recursive: true });

    await recordConversationEvent('conv-evt2', '2026-11-24T01:00:00.000Z', {
      kind: 'compass_followup_sent',
      title: '发起服务端协查',
    });
    await recordConversationEvent('conv-evt2', null, {
      kind: 'compass_followup_settled',
      title: '服务端协查回执（完成）',
    });

    const entries = await readdir(join(root, 'conversations'));
    assert.deepEqual(entries, ['2026-11-24_18-07-31_conv-evt2']);

    const events = await readEvents(root, 'conv-evt2');
    assert.deepEqual(
      events.map((event) => event.kind),
      ['compass_followup_sent', 'compass_followup_settled'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
