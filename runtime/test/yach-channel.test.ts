import assert from 'node:assert/strict';
import test from 'node:test';

import { DiagnosisReportSchema } from '../src/domain/schemas.js';
import { formatYachFinalReply } from '../src/channels/yach/channel.js';

test('知音楼只发送最终结构化报告，不发送协查前的中间汇总', () => {
  const report = DiagnosisReportSchema.parse({
    verdict: 'insufficient_evidence',
    summary: '联合调查完成，当前只能确认客户端入口状态。',
    issue_category: 'implementation',
    task_type: 'implementation',
    confidence: 0.4,
    responsibility: 'unknown',
    root_cause_candidates: [],
    missing_information: ['需要确认权益接口字段'],
    joint_assessment: {
      relation: 'unverified',
      text: '远端结果需要源码或接口证据复核。',
      verified_claims: [],
      unverified_claims: ['仅来自远端 Agent 报告：解锁状态由权益接口返回。'],
      next_actions: ['补充当前版本和端形态'],
    },
    evidence: [],
    external_findings: [{
      consultation_id: 'consult-1',
      task_id: 'task-1',
      context_id: null,
      agent_id: 'compass',
      agent_version: null,
      state: 'TASK_STATE_COMPLETED',
      text: '解锁状态由权益接口返回。',
      truncated: false,
      scope: ['current_question'],
      limitations: [],
      request_digest: 'sha256:test',
      received_at: '2026-11-13T07:00:00.000Z',
    }],
  });

  const reply = formatYachFinalReply(
    report,
    '用户问题原文：旧的协查前汇总',
    'http://127.0.0.1:5174/xesapp-agent/',
  );

  assert.match(reply, /最终诊断结论/);
  assert.match(reply, /解锁状态由权益接口返回/);
  assert.match(reply, /补充当前版本和端形态/);
  assert.doesNotMatch(reply, /用户问题原文：旧的协查前汇总/);
  assert.match(reply, /完整报告请打开工作台/);
});

test('没有最终报告时才回退到诊断正文', () => {
  const reply = formatYachFinalReply(null, '诊断失败，请打开工作台。', '/xesapp-agent/');
  assert.match(reply, /诊断失败，请打开工作台/);
});
