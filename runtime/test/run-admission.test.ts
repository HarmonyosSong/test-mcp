import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryRunAdmission } from '../src/orchestration/admission.js';

test('同会话互斥，不同会话可并行，释放后可重新准入', async () => {
  const admission = new InMemoryRunAdmission(2);
  const first = await admission.acquire({ conversationId: 'c1', runId: 'r1' });
  assert.equal(first.ok, true);
  assert.equal((await admission.acquire({ conversationId: 'c1' })).ok, false);
  assert.deepEqual(await admission.acquire({ conversationId: 'c1' }), {
    ok: false,
    reason: 'conversation_busy',
  });

  const second = await admission.acquire({ conversationId: 'c2', runId: 'r2' });
  assert.equal(second.ok, true);
  assert.deepEqual(await admission.acquire({ conversationId: 'c3' }), {
    ok: false,
    reason: 'global_busy',
  });
  assert.equal(admission.activeRunCount, 2);

  await admission.release('r1');
  await admission.release('r1');
  assert.equal(admission.activeRunCount, 1);
  const third = await admission.acquire({ conversationId: 'c3', runId: 'r3' });
  assert.equal(third.ok, true);
  await admission.release('r2');
  await admission.release('r3');
  assert.equal(admission.activeRunCount, 0);
});

test('并发获取不会超过全局槽位，等待确认释放采用同一 release 语义', async () => {
  const admission = new InMemoryRunAdmission(4);
  const results = await Promise.all([
    admission.acquire({ conversationId: 'c1', runId: 'r1' }),
    admission.acquire({ conversationId: 'c2', runId: 'r2' }),
    admission.acquire({ conversationId: 'c3', runId: 'r3' }),
    admission.acquire({ conversationId: 'c4', runId: 'r4' }),
    admission.acquire({ conversationId: 'c5', runId: 'r5' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 4);
  assert.equal(results.filter((result) => !result.ok && result.reason === 'global_busy').length, 1);

  // waiting_confirmation 与正常终态都释放全局槽位，恢复时重新 acquire。
  await admission.release('r1');
  const resumed = await admission.acquire({ conversationId: 'c1', runId: 'r1-resumed' });
  assert.equal(resumed.ok, true);
});

test('IM 等待可被槽位释放唤醒，也可被停止操作中断', async () => {
  const admission = new InMemoryRunAdmission(1);
  await admission.acquire({ conversationId: 'c1', runId: 'r1' });
  const waiting = admission.waitForChange();
  await admission.release('r1');
  await waiting;

  const abort = new AbortController();
  const interrupted = admission.waitForChange(abort.signal);
  abort.abort();
  await interrupted;
});

test('并发配置必须为正整数', () => {
  assert.throws(() => new InMemoryRunAdmission(0));
  assert.throws(() => new InMemoryRunAdmission(1.5));
});
