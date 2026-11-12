import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvestigationPlan, type InvestigationPlanInput } from '../src/orchestration/plan.js';
import {
  loadServerSignals,
  matchServerSignals,
  parseServerSignals,
} from '../src/orchestration/server-signals.js';

const budget = { maxSeconds: 300, maxRemoteCalls: 2 };

function input(overrides: Partial<InvestigationPlanInput> = {}): InvestigationPlanInput {
  return {
    question: '页面打开失败',
    repositoryBound: true,
    hasLocalEvidence: false,
    hasLogObservation: false,
    compassEnabled: true,
    budget,
    ...overrides,
  };
}

const signals = parseServerSignals(`
version: 1
serviceNames: [payment-service]
apiPrefixes: [/api/pay/]
errorCodePatterns: ['(?<![A-Za-z0-9])5[0-9]{2}(?![A-Za-z0-9])']
`);

test('默认词表不会仅因支付失败就调用服务端', async () => {
  const defaults = await loadServerSignals();
  assert.equal(matchServerSignals('我支付失败', defaults).matched, false);
  assert.equal(matchServerSignals('支付接口返回 HTTP 502', defaults).matched, true);

  const plan = createInvestigationPlan(input({ question: '我支付失败' }), defaults);
  assert.equal(plan.mode, 'local');
});

test('用户明确指定优先于自动分流，服务端协查不可用时回退本地', () => {
  const explicitClient = createInvestigationPlan(input({
    question: '/api/pay/ 返回 500',
    requestedScope: 'client',
    correlation: { traceId: 'trace-1' },
  }), signals);
  assert.equal(explicitClient.mode, 'local');
  assert.deepEqual(explicitClient.clientSteps, ['observe', 'source']);

  const explicitServer = createInvestigationPlan(input({
    requestedScope: 'server',
    repositoryBound: false,
  }), signals);
  assert.equal(explicitServer.mode, 'server');
  assert.deepEqual(explicitServer.branches, ['server']);
  assert.deepEqual(explicitServer.clientSteps, []);

  const disabled = createInvestigationPlan(input({
    requestedScope: 'server',
    compassEnabled: false,
  }), signals);
  assert.equal(disabled.mode, 'local');
  assert.deepEqual(disabled.remoteSlots, []);
});

test('服务端特征和关联标识不能绕过现场观察，已有日志观测时才直接并行', () => {
  const firstLook = createInvestigationPlan(input({
    question: 'payment-service 返回 500',
    correlation: { traceId: 'trace-1' },
  }), signals);
  assert.equal(firstLook.mode, 'local');
  assert.deepEqual(firstLook.branches, ['client']);
  assert.deepEqual(firstLook.clientSteps, ['observe', 'source']);
  assert.match(firstLook.reason, /尚无本地日志观测/);

  const parallel = createInvestigationPlan(input({
    question: 'payment-service 返回 500',
    correlation: { traceId: 'trace-1' },
    hasLogObservation: true,
  }), signals);
  assert.equal(parallel.mode, 'parallel');
  assert.deepEqual(parallel.branches, ['client', 'server']);
  assert.deepEqual(parallel.remoteSlots, ['compass']);
  assert.equal(parallel.externalScope, 'frontend_backend');
  assert.equal(parallel.correlationReady, true);

  const requestId = createInvestigationPlan(input({
    question: '/api/pay/ 返回 500',
    correlation: { requestId: 'request-1' },
    hasLogObservation: true,
  }), signals);
  assert.equal(requestId.mode, 'parallel');

  const missingCorrelation = createInvestigationPlan(input({
    question: '/api/pay/ 返回 500',
    hasLogObservation: true,
  }), signals);
  assert.equal(missingCorrelation.mode, 'local');
  assert.equal(missingCorrelation.correlationReady, false);
});

test('无仓库且无本地证据时先走知识澄清，不自动并行', () => {
  const plan = createInvestigationPlan(input({
    question: '/api/pay/ 返回 500',
    repositoryBound: false,
    hasLocalEvidence: false,
    correlation: { traceId: 'trace-1' },
  }), signals);
  assert.equal(plan.mode, 'local');
  assert.deepEqual(plan.clientSteps, ['observe']);
});

test('开关或远端预算关闭时，自动分流始终保持本地', () => {
  for (const override of [{ compassEnabled: false }, { budget: { maxSeconds: 300, maxRemoteCalls: 0 } }]) {
    const plan = createInvestigationPlan(input({
      question: '/api/pay/ 返回 500',
      correlation: { traceId: 'trace-1' },
      hasLogObservation: true,
      ...override,
    }), signals);
    assert.equal(plan.mode, 'local');
  }
});

test('词表拒绝未知字段、非法正则和非法预算', () => {
  assert.throws(() => parseServerSignals(`
version: 1
serviceNames: []
apiPrefixes: []
errorCodePatterns: ['[']
`));
  assert.throws(() => parseServerSignals(`
version: 1
serviceNames: []
apiPrefixes: []
errorCodePatterns: []
extra: true
`));
  assert.throws(() => createInvestigationPlan(input({
    budget: { maxSeconds: 0, maxRemoteCalls: 1 },
  }), signals));
  assert.throws(() => createInvestigationPlan(input({ maxHandoffRounds: -1 }), signals));
});
