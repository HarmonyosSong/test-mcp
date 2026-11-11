import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentSlotRegistryError,
  InMemoryAgentSlotRegistry,
  type AgentSlotAdapter,
  type CapabilityContext,
  type RemoteAgentSlot,
} from '../src/orchestration/agent-slot-registry.js';

const context: CapabilityContext = {
  conversationId: 'conversation-1',
  messageId: 'message-1',
  runId: 'run-1',
  workspacePath: null,
};

function slot(slotId: string, role: RemoteAgentSlot['role'] = 'server'): RemoteAgentSlot {
  return {
    slotId,
    agentCardUrl: `https://${slotId}.example.test/agent-card`,
    role,
    capabilities: ['diagnosis'],
    authRef: `${slotId}-auth-ref`,
    timeoutMs: 1_000,
    maxOutputChars: 4_000,
    evidenceMode: 'external_findings',
  };
}

function adapter(name: string, calls: string[]): AgentSlotAdapter {
  return {
    async invoke(currentSlot) {
      calls.push(`invoke:${name}:${currentSlot.slotId}`);
      return { data: { slotId: currentSlot.slotId }, truncated: false, limitations: [] };
    },
    async cancel(currentSlot, taskId) {
      calls.push(`cancel:${name}:${currentSlot.slotId}:${taskId}`);
    },
  };
}

test('配置 Map 可按 slotId 分发不同角色的远端 Agent', async () => {
  const calls: string[] = [];
  const compass = slot('compass', 'server');
  const specialist = slot('repo-specialist', 'specialist');
  const registry = new InMemoryAgentSlotRegistry([
    { slot: compass, adapter: adapter('compass', calls) },
    { slot: specialist, adapter: adapter('specialist', calls) },
  ]);

  assert.deepEqual(await registry.resolve('compass', context), compass);
  assert.deepEqual(await registry.resolve('repo-specialist', context), specialist);
  const result = await registry.invoke(specialist, { text: '检查仓库' }, context);
  assert.deepEqual(result.data, { slotId: 'repo-specialist' });
  await registry.cancel(compass, 'task-1', context);
  assert.deepEqual(calls, [
    'invoke:specialist:repo-specialist',
    'cancel:compass:compass:task-1',
  ]);
});

test('重复和未知槽位均被拒绝', async () => {
  const calls: string[] = [];
  const registry = new InMemoryAgentSlotRegistry();
  registry.register(slot('compass'), adapter('first', calls));
  assert.throws(
    () => registry.register(slot('compass'), adapter('duplicate', calls)),
    (error: unknown) => error instanceof AgentSlotRegistryError &&
      error.code === 'duplicate_agent_slot',
  );
  await assert.rejects(
    registry.resolve('missing', context),
    (error: unknown) => error instanceof AgentSlotRegistryError &&
      error.code === 'unknown_agent_slot',
  );
  await assert.rejects(
    registry.invoke(slot('missing'), { text: '不应发送' }, context),
    /not available/,
  );
  assert.deepEqual(calls, []);
});

test('停用槽位不可解析或调用，启用后恢复；停用不阻止已有任务取消', async () => {
  const calls: string[] = [];
  const registry = new InMemoryAgentSlotRegistry([
    { slot: slot('compass'), adapter: adapter('compass', calls), enabled: false },
  ]);
  await assert.rejects(
    registry.resolve('compass', context),
    (error: unknown) => error instanceof AgentSlotRegistryError &&
      error.code === 'unknown_agent_slot',
  );

  registry.enable('compass');
  const resolved = await registry.resolve('compass', context);
  await registry.invoke(resolved, { text: '调查' }, context);
  registry.disable('compass');
  await assert.rejects(registry.invoke(resolved, { text: '不应发送' }, context));
  await registry.cancel(resolved, 'task-existing', context);
  assert.deepEqual(calls, [
    'invoke:compass:compass',
    'cancel:compass:compass:task-existing',
  ]);
  assert.throws(() => registry.setEnabled('missing', true), /not available/);
});

test('注册时拒绝非法超时、输出上限和证据模式', () => {
  const registry = new InMemoryAgentSlotRegistry();
  for (const invalid of [
    { ...slot('timeout'), timeoutMs: 0 },
    { ...slot('output'), maxOutputChars: 0 },
    { ...slot('evidence'), evidenceMode: 'source' },
  ]) {
    assert.throws(
      () => registry.register(invalid as RemoteAgentSlot, adapter('invalid', [])),
      (error: unknown) => error instanceof AgentSlotRegistryError &&
        error.code === 'invalid_agent_slot',
    );
  }
});
