import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceChatEvent } from '../src/agui/chatReducer.ts';
import { investigationProgressForEvent } from '../src/agui/progress.ts';
import { consultationDecisionErrorMessage, pendingConsultations } from '../src/consultation.ts';

const conversation = {
  id: 'conv-1',
  title: '测试',
  messages: [],
  consultations: [],
  run_state: 'running',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const consultation = {
  id: 'consult-1',
  status: 'pending',
  reason: '继续核查请求失败原因',
  outbound_text: '问题：页面异常\ntraceId: trace-1',
  outbound_digest: 'digest',
  expires_at: '2026-01-01T01:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

test('外发确认事件只追加固定内容并进入等待状态', () => {
  const next = reduceChatEvent(conversation, {
    type: 'EXTERNAL_CONSULTATION_REQUIRED',
    run_id: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    consultation,
  });
  assert.equal(next?.run_state, 'waiting_confirmation');
  assert.deepEqual(next?.consultations, [consultation]);
  assert.deepEqual(pendingConsultations(next), [consultation]);
  assert.deepEqual(pendingConsultations({ ...next, run_state: 'completed' }), []);
});

test('编排进度使用面向 IT 老师的阶段描述，不要求技术路由选择', () => {
  assert.deepEqual(
    investigationProgressForEvent({ type: 'BRANCH_STATUS', branch: 'server', status: 'running' }),
    { text: '正在进一步协查', state: 'active' },
  );
  assert.deepEqual(
    investigationProgressForEvent({ type: 'EXTERNAL_CONSULTATION_REQUIRED' }),
    { text: '需要你确认是否发送协查信息', state: 'waiting' },
  );
  assert.deepEqual(
    investigationProgressForEvent({ type: 'JOINT_ASSESSMENT' }),
    { text: '正在整理结论', state: 'active' },
  );
});

test('审批 409/429 给出明确提示，不自动重试', () => {
  assert.match(consultationDecisionErrorMessage({ status: 409 }, 'approve'), /状态已变化/);
  assert.match(consultationDecisionErrorMessage({ status: 429 }, 'approve'), /不会自动重复提交/);
});
