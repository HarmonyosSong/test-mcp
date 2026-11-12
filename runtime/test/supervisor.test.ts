import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeSupervisor,
  type Branch,
  type BranchResult,
} from '../src/orchestration/supervisor.js';
import type { InvestigationPlan } from '../src/orchestration/plan.js';

function plan(mode: InvestigationPlan['mode'] = 'local'): InvestigationPlan {
  return {
    mode,
    branches: mode === 'local' ? ['client'] : mode === 'server' ? ['server'] : ['client', 'server'],
    remoteSlots: mode === 'local' ? [] : ['compass'],
    clientSteps: mode === 'server' ? [] : ['observe', 'source'],
    reason: 'test',
    correlationReady: true,
    budget: { maxSeconds: 1, maxRemoteCalls: 2 },
    maxHandoffRounds: 1,
  };
}

function branch(
  name: 'client' | 'server',
  result: Partial<BranchResult> = {},
  calls: string[] = [],
): Branch {
  return {
    async run() {
      calls.push(`run:${name}`);
      return { branch: name, status: 'completed', ...result };
    },
    async cancel() {
      calls.push(`cancel:${name}`);
    },
  };
}

function input(overrides: Partial<Parameters<RuntimeSupervisor['run']>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      plan: plan(),
      branches: { client: branch('client', {}, calls), server: branch('server', {}, calls) },
      context: { compassEnabled: true },
      approveRemote: async () => {
        calls.push('approve');
        return true;
      },
      ...overrides,
    } satisfies Parameters<RuntimeSupervisor['run']>[0],
  };
}

test('本地无跨侧路由时只执行客户端', async () => {
  const { value, calls } = input();
  const result = await new RuntimeSupervisor().run(value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['run:client']);
  assert.equal(result.planHistory.length, 1);
});

test('本地报告给出明确服务端路由时自动接续并完成远端分支', async () => {
  const { value, calls } = input();
  value.branches.client = branch('client', {
    responsibility: 'server',
    nextAction: '核查指定请求的服务端错误',
    hasObservedEvidence: true,
  }, calls);
  const result = await new RuntimeSupervisor().run(value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['run:client', 'approve', 'run:server']);
  assert.deepEqual(result.planHistory.map((item) => item.mode), ['local', 'server']);
  assert.equal(result.budget.handoffRoundsUsed, 1);
  assert.equal(result.budget.remoteCallsUsed, 1);
});

test('缺少关联信息时仍按显式路由自动接续外部协查，缺口由外发摘要声明', async () => {
  const { value, calls } = input();
  value.plan.correlationReady = false;
  value.branches.client = branch('client', {
    responsibility: 'server',
    nextAction: '核查服务端',
    hasObservedEvidence: true,
  }, calls);
  const result = await new RuntimeSupervisor().run(value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['run:client', 'approve', 'run:server']);
  assert.deepEqual(result.planHistory.map((item) => item.mode), ['local', 'server']);
});

test('实现查询经授权后接续统一外部 Agent，不要求本地观测或关联信息', async () => {
  const { value, calls } = input();
  value.plan.correlationReady = false;
  value.branches.client = branch('client', {
    responsibility: 'unknown',
    taskType: 'implementation',
    nextAction: '请核查排行榜的前端、H5 与服务端接口实现',
    hasObservedEvidence: false,
  }, calls);
  const result = await new RuntimeSupervisor().run(value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['run:client', 'approve', 'run:server']);
  assert.deepEqual(result.planHistory.map((item) => item.mode), ['local', 'server']);
  assert.equal(result.budget.handoffRoundsUsed, 1);
  assert.equal(result.budget.remoteCallsUsed, 1);
});

test('并行模式授权等待不阻塞客户端启动，拒绝后保留本地结果', async () => {
  const { value, calls } = input({ plan: plan('parallel') });
  let approve!: (value: boolean) => void;
  value.approveRemote = async () => {
    calls.push('approve');
    return new Promise<boolean>((resolve) => { approve = resolve; });
  };
  const running = new RuntimeSupervisor().run(value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['run:client', 'approve']);
  approve(false);
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.results.map((item) => item.status), ['completed', 'skipped']);
  assert.equal(calls.includes('run:server'), false);
});

test('服务端失败不丢弃客户端已完成结果', async () => {
  const { value, calls } = input({ plan: plan('parallel') });
  value.branches.server = {
    async run() { throw new Error('remote unavailable'); },
    async cancel() {},
  };
  const result = await new RuntimeSupervisor().run(value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.results.map((item) => item.status), ['completed', 'failed']);
  assert.equal(result.results[0]?.branch, 'client');
});

test('预算到期传播取消，不伪造成分支完成', async () => {
  const { value, calls } = input();
  value.plan.budget.maxSeconds = 0.01;
  value.branches.client = {
    async run(_plan, context) {
      await new Promise<void>((resolve) => {
        if (context.abortSignal.aborted) return resolve();
        context.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    },
    async cancel() { calls.push('cancel:client'); },
  };
  const result = await new RuntimeSupervisor().run(value);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.results.map((item) => item.status), ['cancelled']);
  assert.ok(calls.includes('cancel:client'));
});
