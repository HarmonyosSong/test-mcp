import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompassSlotAdapter,
  CompassSlotError,
  type CompassSlotClient,
} from '../src/capabilities/compass-slot.js';
import type {
  CapabilityContext,
  RemoteAgentSlot,
} from '../src/orchestration/agent-slot-registry.js';

function slot(overrides: Partial<RemoteAgentSlot> = {}): RemoteAgentSlot {
  return {
    slotId: 'compass',
    agentCardUrl: 'https://compass.example.test/agent-card',
    role: 'server',
    capabilities: ['server-diagnosis'],
    authRef: 'compass-auth-ref',
    timeoutMs: 100,
    maxOutputChars: 5,
    evidenceMode: 'external_findings',
    ...overrides,
  };
}

function context(abortSignal?: AbortSignal): CapabilityContext {
  return {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    runId: 'run-1',
    workspacePath: null,
    abortSignal,
  };
}

test('invoke 传递轮次 messageId，记录 progress taskId，并限长标记外部结论', async () => {
  let sent: Parameters<CompassSlotClient['sendStreamingMessage']>[0] | undefined;
  const client: CompassSlotClient = {
    async sendStreamingMessage(input) {
      sent = input;
      input.onProgress?.({ kind: 'task', taskId: 'task-progress', summary: 'working' });
      return {
        text: 'abcdefgh',
        taskId: null,
        contextId: 'context-remote',
        state: 'TASK_STATE_COMPLETED',
      };
    },
    async cancelTask() {},
  };
  const adapter = new CompassSlotAdapter(client, { now: () => 42 });
  const result = await adapter.invoke(
    slot(),
    { text: '  调查服务端  ', contextId: ' context-input ' },
    context(),
  );

  assert.equal(sent?.text, '调查服务端');
  assert.equal(sent?.contextId, 'context-input');
  assert.equal(sent?.messageId, 'message-1');
  assert.deepEqual(result.data, {
    text: 'abcde',
    taskId: 'task-progress',
    contextId: 'context-remote',
    state: 'TASK_STATE_COMPLETED',
  });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.limitations, ['remote_output_truncated_by_max_output_chars']);
  assert.deepEqual(result.audit, {
    slotId: 'compass',
    taskId: 'task-progress',
    state: 'TASK_STATE_COMPLETED',
    durationMs: 0,
    truncated: true,
  });
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
  assert.equal(JSON.stringify(result).includes('compass-auth-ref'), false);
});

test('非 completed 状态和缺失状态保留原值并进入 limitations', async () => {
  for (const state of ['TASK_STATE_FAILED', null]) {
    const adapter = new CompassSlotAdapter({
      async sendStreamingMessage() {
        return { text: 'partial', taskId: 'task-1', contextId: null, state };
      },
      async cancelTask() {},
    });
    const result = await adapter.invoke(slot({ maxOutputChars: 100 }), { text: '调查' }, context());
    assert.deepEqual(result.data, {
      text: 'partial', taskId: 'task-1', contextId: null, state,
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.limitations, [`remote_not_completed:${state ?? 'unknown'}`]);
    assert.equal(result.audit?.state, state);
  }
});

test('显式 cancel 使用新的非 abort 信号，成功只标记 cancel_requested', async () => {
  const controller = new AbortController();
  controller.abort();
  let cancelSignal: AbortSignal | undefined;
  const audits: Array<{ state: string | null }> = [];
  const adapter = new CompassSlotAdapter({
    async sendStreamingMessage() { throw new Error('不应调用'); },
    async cancelTask(taskId, signal) {
      assert.equal(taskId, 'task-1');
      cancelSignal = signal;
    },
  }, { onAudit: (audit) => audits.push(audit) });

  await adapter.cancel(slot(), ' task-1 ', context(controller.signal));
  assert.ok(cancelSignal);
  assert.notEqual(cancelSignal, controller.signal);
  assert.equal(cancelSignal.aborted, false);
  assert.equal(audits[0]?.state, 'cancel_requested');
});

test('外部 abort 后尽力取消 progress 中的 taskId，且不复用已 abort 信号', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const sendStarted = new Promise<void>((resolve) => { started = resolve; });
  let cancelTaskId: string | undefined;
  let cancelSignal: AbortSignal | undefined;
  const adapter = new CompassSlotAdapter({
    async sendStreamingMessage(input) {
      input.onProgress?.({ kind: 'task', taskId: 'task-abort', summary: 'working' });
      started();
      return new Promise((_, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(new Error('upstream aborted')), { once: true });
      });
    },
    async cancelTask(taskId, signal) {
      cancelTaskId = taskId;
      cancelSignal = signal;
    },
  });

  const invoking = adapter.invoke(slot(), { text: '调查' }, context(controller.signal));
  await sendStarted;
  controller.abort();
  await assert.rejects(invoking, { name: 'AbortError' });
  assert.equal(cancelTaskId, 'task-abort');
  assert.ok(cancelSignal);
  assert.notEqual(cancelSignal, controller.signal);
  assert.equal(cancelSignal.aborted, false);
});

test('超时强制结束等待并尽力取消，清理失败仍保持 external_timeout', async () => {
  let cancelTaskId: string | undefined;
  let cancelSignal: AbortSignal | undefined;
  const adapter = new CompassSlotAdapter({
    async sendStreamingMessage(input) {
      input.onProgress?.({ kind: 'status', taskId: 'task-timeout', summary: 'working' });
      return new Promise((_, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(new Error('secret upstream error')), { once: true });
      });
    },
    async cancelTask(taskId, signal) {
      cancelTaskId = taskId;
      cancelSignal = signal;
      throw new Error('secret cancel error');
    },
  });

  await assert.rejects(
    adapter.invoke(slot({ timeoutMs: 20 }), { text: '调查' }, context()),
    (error: unknown) => {
      assert.ok(error instanceof CompassSlotError);
      assert.equal(error.code, 'external_timeout');
      assert.equal(error.message.includes('secret'), false);
      return true;
    },
  );
  assert.equal(cancelTaskId, 'task-timeout');
  assert.ok(cancelSignal);
  assert.equal(cancelSignal.aborted, false);
});

test('超时保留已收到的 artifact，标记半截结论且不伪造远端取消状态', async () => {
  let cancelTaskId: string | undefined;
  const adapter = new CompassSlotAdapter({
    async sendStreamingMessage(input) {
      input.onProgress?.({ kind: 'task', taskId: 'task-partial', summary: 'working' });
      input.onPartialResult?.({
        text: 'abcdefgh',
        taskId: 'task-partial',
        contextId: 'context-partial',
        state: 'TASK_STATE_WORKING',
      });
      return new Promise((_, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    async cancelTask(taskId) { cancelTaskId = taskId; },
  });

  const result = await adapter.invoke(slot({ timeoutMs: 20 }), { text: '调查' }, context());
  assert.deepEqual(result.data, {
    text: 'abcde',
    taskId: 'task-partial',
    contextId: 'context-partial',
    state: 'TASK_STATE_WORKING',
  });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.limitations, [
    'remote_invocation_timeout',
    'remote_partial_result',
    'remote_output_truncated_by_max_output_chars',
  ]);
  assert.equal(result.audit?.state, 'TASK_STATE_WORKING');
  assert.equal(result.audit?.truncated, true);
  assert.equal(cancelTaskId, 'task-partial');
});

test('非法任务和未确认取消不会泄露上游错误或伪造 cancelled', async () => {
  let sendCalls = 0;
  const audits: Array<{ operation: string; state: string | null }> = [];
  const adapter = new CompassSlotAdapter({
    async sendStreamingMessage() {
      sendCalls += 1;
      throw new Error('不应调用');
    },
    async cancelTask() { throw new Error('secret cancel failure'); },
  }, { onAudit: (audit) => audits.push(audit) });

  await assert.rejects(
    adapter.invoke(slot(), { text: '调查', sourceCode: '不得外发' }, context()),
    (error: unknown) => error instanceof CompassSlotError && error.code === 'invalid_task',
  );
  assert.equal(sendCalls, 0);
  await assert.rejects(
    adapter.cancel(slot(), 'task-1', context()),
    (error: unknown) => {
      assert.ok(error instanceof CompassSlotError);
      assert.equal(error.code, 'external_unknown');
      assert.equal(error.message.includes('secret'), false);
      return true;
    },
  );
  assert.deepEqual(
    audits.map(({ operation, state }) => ({ operation, state })),
    [{ operation: 'cancel', state: 'unknown' }],
  );
});
