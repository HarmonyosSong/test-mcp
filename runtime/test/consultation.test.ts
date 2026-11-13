import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveExternalConsultation,
  createExternalConsultation,
  expireExternalConsultation,
  markExternalConsultationSent,
  rejectExternalConsultation,
  transitionExternalConsultation,
} from '../src/orchestration/consultation.js';

function pending() {
  return createExternalConsultation({
    conversationId: 'c1',
    messageId: 'm1',
    runId: 'r1',
    reason: '本地证据指向服务端',
    outboundText: '问题：接口 500\ntraceId=trace-1',
    redact: (text) => text,
    now: new Date('2026-11-10T00:00:00.000Z'),
  });
}

test('确认前不能发送，批准后只能发送固定外发文本', () => {
  const consultation = pending();
  assert.equal(consultation.status, 'pending');
  assert.equal(consultation.attachment_items.length, 0);
  assert.throws(() => markExternalConsultationSent(consultation));

  const approved = approveExternalConsultation(consultation, {
    conversationId: 'c1', runId: 'r1', now: new Date('2026-11-10T00:01:00.000Z'),
  });
  const sent = markExternalConsultationSent(approved, new Date('2026-11-10T00:02:00.000Z'));
  assert.equal(sent.outbound_text, consultation.outbound_text);
  const completed = transitionExternalConsultation(sent, 'completed', { taskId: 'task-1' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.task_id, 'task-1');
});

test('跨会话、跨轮次、过期和被篡改的确认全部拒绝', () => {
  const now = new Date('2026-11-10T00:01:00.000Z');
  assert.throws(() => approveExternalConsultation(pending(), { conversationId: 'c2', runId: 'r1', now }));
  assert.throws(() => approveExternalConsultation(pending(), { conversationId: 'c1', runId: 'r2', now }));
  assert.throws(() => approveExternalConsultation(pending(), {
    conversationId: 'c1', runId: 'r1', now: new Date('2026-11-10T00:16:00.000Z'),
  }));
  const changed = { ...pending(), outbound_text: '模型追加的内容' };
  assert.throws(() => approveExternalConsultation(changed, { conversationId: 'c1', runId: 'r1', now }));
});

test('拒绝不进入发送状态，已终态记录不能重复审批', () => {
  const rejected = rejectExternalConsultation(pending(), {
    conversationId: 'c1', runId: 'r1', now: new Date('2026-11-10T00:01:00.000Z'),
  });
  assert.equal(rejected.status, 'rejected');
  assert.throws(() => markExternalConsultationSent(rejected));
  assert.throws(() => approveExternalConsultation(rejected, { conversationId: 'c1', runId: 'r1' }));
});

test('过期记录单独进入 expired，未过期或内容被篡改时失败关闭', () => {
  const consultation = pending();
  assert.throws(() => expireExternalConsultation(consultation, {
    conversationId: 'c1', runId: 'r1', now: new Date('2026-11-10T00:01:00.000Z'),
  }));
  const expired = expireExternalConsultation(consultation, {
    conversationId: 'c1', runId: 'r1', now: new Date('2026-11-10T00:15:00.000Z'),
  });
  assert.equal(expired.status, 'expired');
  assert.throws(() => markExternalConsultationSent(expired));
  assert.throws(() => expireExternalConsultation(
    { ...pending(), outbound_text: '被篡改' },
    { conversationId: 'c1', runId: 'r1', now: new Date('2026-11-10T00:16:00.000Z') },
  ));
});
