import assert from 'node:assert/strict';
import test from 'node:test';

import { decideLocalContinuation, type LocalContinuationInput } from '../src/orchestration/loop.js';
import type { InvestigationPlan } from '../src/orchestration/plan.js';

const localPlan: InvestigationPlan = {
  mode: 'local',
  branches: ['client'],
  remoteSlots: [],
  clientSteps: ['observe', 'source'],
  reason: '先本地调查',
  correlationReady: false,
  budget: { maxSeconds: 300, maxRemoteCalls: 2 },
  maxHandoffRounds: 1,
};

function input(overrides: Partial<LocalContinuationInput> = {}): LocalContinuationInput {
  return {
    responsibility: 'server',
    nextAction: '核查该请求的服务端失败原因',
    hasObservedEvidence: true,
    compassEnabled: true,
    correlationReady: true,
    budgetExpired: false,
    remoteCallsExhausted: false,
    handoffsExhausted: false,
    ...overrides,
  };
}

test('本地证据给出明确服务端路由时自动接续，不要求用户再次发起', () => {
  const decision = decideLocalContinuation(localPlan, input());
  assert.equal(decision.type, 'continue_server');
  if (decision.type !== 'continue_server') return;
  assert.equal(decision.plan.mode, 'server');
  assert.deepEqual(decision.plan.branches, ['server']);
  assert.deepEqual(decision.plan.remoteSlots, ['compass']);
  assert.deepEqual(decision.plan.clientSteps, []);
  assert.equal(decision.plan.correlationReady, true);
});

test('自动接续必须有明确问题、关联信息和剩余预算', () => {
  for (const override of [
    { nextAction: '' },
    { hasObservedEvidence: false },
    { compassEnabled: false },
    { budgetExpired: true },
    { remoteCallsExhausted: true },
    { handoffsExhausted: true },
    { requestedScope: 'client' as const },
  ]) {
    assert.equal(decideLocalContinuation(localPlan, input(override)).type, 'finish');
  }
  assert.equal(
    decideLocalContinuation(localPlan, input({ correlationReady: false })).type,
    'needs_user_facts',
  );
});

test('客户端、未知路由及非本地起始计划不会自动跨侧', () => {
  for (const responsibility of ['client', 'unknown'] as const) {
    assert.equal(decideLocalContinuation(localPlan, input({ responsibility })).type, 'finish');
  }
  const parallel: InvestigationPlan = { ...localPlan, mode: 'parallel', branches: ['client', 'server'] };
  assert.equal(decideLocalContinuation(parallel, input()).type, 'finish');
});
