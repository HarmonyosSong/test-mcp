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
    taskType: 'incident',
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

test('故障证据给出明确外部路由时自动接续，不要求用户再次发起', () => {
  const decision = decideLocalContinuation(localPlan, input());
  assert.equal(decision.type, 'continue_external');
  if (decision.type !== 'continue_external') return;
  assert.equal(decision.plan.mode, 'server');
  assert.deepEqual(decision.plan.branches, ['server']);
  assert.deepEqual(decision.plan.remoteSlots, ['compass']);
  assert.equal(decision.plan.externalScope, 'frontend_backend');
  assert.deepEqual(decision.plan.clientSteps, []);
  assert.equal(decision.plan.correlationReady, true);
});

test('故障无本地观测也可外协；无问题、关协查、耗尽预算或限定客户端时结束', () => {
  assert.equal(
    decideLocalContinuation(localPlan, input({ hasObservedEvidence: false })).type,
    'continue_external',
  );
  for (const override of [
    { nextAction: '' },
    { compassEnabled: false },
    { budgetExpired: true },
    { remoteCallsExhausted: true },
    { handoffsExhausted: true },
    { requestedScope: 'client' as const },
  ]) {
    assert.equal(decideLocalContinuation(localPlan, input(override)).type, 'finish');
  }
});

test('缺少请求关联标识不阻断故障外发，关联缺口透传进接续计划', () => {
  const decision = decideLocalContinuation(localPlan, input({ correlationReady: false }));
  assert.equal(decision.type, 'continue_external');
  if (decision.type !== 'continue_external') return;
  assert.equal(decision.plan.correlationReady, false);
  assert.equal(decision.plan.mode, 'server');
});

test('实现查询由统一外部全栈 Agent 接续，不要求本地观测或请求关联标识', () => {
  const decision = decideLocalContinuation(
    localPlan,
    input({
      taskType: 'implementation',
      responsibility: 'unknown',
      nextAction: '请核查英语绘本阅读排行榜的前端、H5 与服务端实现',
      hasObservedEvidence: false,
      correlationReady: false,
    }),
  );
  assert.equal(decision.type, 'continue_external');
  if (decision.type !== 'continue_external') return;
  assert.equal(decision.plan.mode, 'server');
  assert.deepEqual(decision.plan.branches, ['server']);
  assert.deepEqual(decision.plan.remoteSlots, ['compass']);
  assert.equal(decision.plan.externalScope, 'frontend_backend');
  assert.deepEqual(decision.plan.clientSteps, []);
  assert.equal(decision.plan.correlationReady, false);
  assert.match(decision.plan.reason, /统一外部全栈 Agent/);
  assert.match(decision.plan.reason, /不代表服务端责任已确认/);
});

test('实现查询已有本地源码观测时也不额外要求 traceId', () => {
  const decision = decideLocalContinuation(localPlan, input({
    taskType: 'implementation',
    responsibility: 'client',
    hasObservedEvidence: true,
    correlationReady: false,
  }));
  assert.equal(decision.type, 'continue_external');
});

test('显式外部路由与责任判断解耦，规则查询也可在知识不足时协查', () => {
  for (const responsibility of ['client', 'unknown'] as const) {
    const decision = decideLocalContinuation(localPlan, input({
      taskType: 'rule',
      responsibility,
      hasObservedEvidence: false,
      correlationReady: false,
    }));
    assert.equal(decision.type, 'continue_external');
  }
});

test('信息查询外发仍受用户范围、协查开关、明确问题和预算约束', () => {
  for (const override of [
    { requestedScope: 'client' as const },
    { compassEnabled: false },
    { budgetExpired: true },
    { remoteCallsExhausted: true },
    { handoffsExhausted: true },
    { nextAction: '' },
  ]) {
    assert.equal(decideLocalContinuation(localPlan, input({
      taskType: 'implementation',
      hasObservedEvidence: false,
      correlationReady: false,
      ...override,
    })).type, 'finish');
  }
});

test('没有显式外部问题时不路由，非本地起始计划不重复接续', () => {
  for (const responsibility of ['client', 'unknown'] as const) {
    assert.equal(decideLocalContinuation(localPlan, input({ responsibility, nextAction: undefined })).type, 'finish');
  }
  const parallel: InvestigationPlan = { ...localPlan, mode: 'parallel', branches: ['client', 'server'] };
  assert.equal(decideLocalContinuation(parallel, input()).type, 'finish');
});
