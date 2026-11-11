import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentSlotRegistry } from '../src/orchestration/agent-slot-registry.js';
import { approveExternalConsultation, createExternalConsultation } from '../src/orchestration/consultation.js';
import { CompassServerBranch, type CompassServerBranchData } from '../src/orchestration/server-branch.js';
import type { BranchContext } from '../src/orchestration/supervisor.js';
import type { InvestigationPlan } from '../src/orchestration/plan.js';

const plan = { mode: 'server' } as InvestigationPlan;
const context = {
  abortSignal: new AbortController().signal,
  compassEnabled: true,
  capabilityContext: { conversationId: 'c1', messageId: 'm1', runId: 'r1' },
} as BranchContext;

function consultation(approved = true) {
  const pending = createExternalConsultation({
    conversationId: 'c1', messageId: 'm1', runId: 'r1', reason: '接续调查',
    outboundText: '本轮问题', redact: (text) => text,
  });
  return approved ? approveExternalConsultation(pending, { conversationId: 'c1', runId: 'r1' }) : pending;
}

function registry(state = 'TASK_STATE_COMPLETED') {
  const calls: string[] = [];
  const value = {
    async resolve() {
      calls.push('resolve');
      return { slotId: 'compass' };
    },
    async invoke() {
      calls.push('invoke');
      return {
        data: { text: '远端结论', taskId: 'task-1', contextId: 'context-1', state },
        truncated: false,
        limitations: [],
        audit: { slotId: 'compass', taskId: 'task-1', state, durationMs: 3, truncated: false },
      };
    },
    async cancel() { calls.push('cancel'); },
  } as unknown as AgentSlotRegistry;
  return { value, calls };
}

test('未批准咨询零 Slot 调用', async () => {
  const remote = registry();
  const branch = new CompassServerBranch(remote.value, {
    consultation: consultation(false), onConsultationUpdate: async () => {},
  });
  const result = await branch.run(plan, context);
  assert.equal(result.status, 'skipped');
  assert.deepEqual(remote.calls, []);
});

test('已批准咨询先落 sent，再调用 Slot 并保存外部结论', async () => {
  const remote = registry();
  const states: string[] = [];
  const audits: string[] = [];
  const branch = new CompassServerBranch(remote.value, {
    consultation: consultation(),
    onConsultationUpdate: async (value) => { states.push(value.status); },
    onAudit: async (value) => { audits.push(value.operation); },
  });
  const result = await branch.run(plan, context);
  assert.equal(result.status, 'completed');
  assert.deepEqual(states, ['sent', 'completed']);
  assert.deepEqual(remote.calls, ['resolve', 'invoke']);
  assert.deepEqual(audits, ['invoke']);
  const data = result.data as CompassServerBranchData;
  assert.equal(data.remoteConclusion.consultation_id, data.consultation.id);
  assert.equal(data.remoteConclusion.task_id, 'task-1');
  assert.equal(data.remoteConclusion.text, '远端结论');
});

test('远端非完成状态保留结论但分支不冒充成功', async () => {
  const remote = registry('TASK_STATE_FAILED');
  const branch = new CompassServerBranch(remote.value, {
    consultation: consultation(), onConsultationUpdate: async () => {},
  });
  const result = await branch.run(plan, context);
  assert.equal(result.status, 'failed');
  assert.equal((result.data as CompassServerBranchData).remoteConclusion.state, 'TASK_STATE_FAILED');
});

test('Slot 异常只记录 unknown，不泄露上游错误', async () => {
  const remote = registry();
  remote.value.invoke = async () => { throw new Error('upstream secret'); };
  const states: string[] = [];
  const branch = new CompassServerBranch(remote.value, {
    consultation: consultation(), onConsultationUpdate: async (value) => { states.push(value.status); },
  });
  const result = await branch.run(plan, context);
  assert.equal(result.status, 'failed');
  assert.deepEqual(states, ['sent', 'unknown']);
  assert.equal(result.error?.includes('upstream secret'), false);
});
