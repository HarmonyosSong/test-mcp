import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrepareSourceTool } from '../src/capabilities/prepare-source-tool.js';
import { LazySourceHolder } from '../src/capabilities/lazy-source.js';
import { ConversationRecordSchema } from '../src/domain/schemas.js';

const timestamp = '2026-11-17T00:00:00.000Z';

function makeConversation(content: string) {
  return ConversationRecordSchema.parse({
    id: 'conv-prepare',
    title: 't',
    messages: [{ id: 'msg-1', role: 'user', content, created_at: timestamp }],
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function fakeProvider(log: string[]) {
  return {
    async createRepositorySession(_conversationId: string, snapshotPath: string) {
      log.push(`bind:${snapshotPath}`);
      return {
        client: { async disconnect() { log.push(`disconnect:${snapshotPath}`); } },
        toolsets: { repository: {} },
      } as never;
    },
  };
}

function executeTool(tool: ReturnType<typeof createPrepareSourceTool>, args: { hint?: string } = {}) {
  return tool.execute!(args, {} as never) as Promise<Record<string, unknown>>;
}

test('未配置绑定服务时返回 unavailable 而不是抛错', async () => {
  const conversation = makeConversation('鸿蒙 3.2.1 提交作业失败');
  const holder = new LazySourceHolder(fakeProvider([]), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    bind: undefined,
    holder,
    content: '鸿蒙 3.2.1 提交作业失败',
  });
  const result = await executeTool(tool);
  assert.equal(result.status, 'unavailable');
  assert.match(String(result.limitation), /未配置/);
});

test('绑定成功：写回会话字段并热替换懒源码会话', async () => {
  const log: string[] = [];
  const conversation = makeConversation('鸿蒙 3.2.1 提交作业失败');
  const holder = new LazySourceHolder(fakeProvider(log), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙 3.2.1 提交作业失败',
    bind: async (input) => {
      assert.equal(input.platform, 'harmony');
      assert.equal(input.version, '3.2.1');
      return {
        workspace_path: '/snapshots/harmony-3.2.1',
        platform: 'harmony',
        version: '3.2.1',
        source_repositories: [{
          repository_id: 'repo-1',
          repository_name: 'xes-harmony',
          requested_ref: 'v3.2.1',
          resolved_commit: 'deadbeef',
          role: 'shell',
          mount_path: '',
        }],
        source_completeness: 'complete',
        source_limitations: [],
      };
    },
  });
  const result = await executeTool(tool);
  assert.equal(result.status, 'bound');
  assert.equal(conversation.workspace_path, '/snapshots/harmony-3.2.1');
  assert.equal(holder.bound, true);
  assert.deepEqual(log, ['bind:/snapshots/harmony-3.2.1']);
  const repositories = result.repositories as Array<{ repository_id: string }>;
  assert.equal(repositories[0]?.repository_id, 'repo-1');
});

test('上下文不足时返回 unresolved 缺口说明，不抛错、不绑定', async () => {
  const log: string[] = [];
  const conversation = makeConversation('提交作业失败'); // 无平台/版本信息
  const holder = new LazySourceHolder(fakeProvider(log), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '提交作业失败',
    bind: async () => {
      throw new Error('不应被调用：无平台信息时 prepareConversationSource 直接返回');
    },
  });
  const result = await executeTool(tool);
  assert.equal(result.status, 'unresolved');
  assert.match(String(result.limitation), /暂未唯一确定/);
  assert.equal(holder.bound, false);
  assert.deepEqual(log, []);
});

test('平台歧义（鸿蒙+安卓）时软返回缺口，不抛 PromptVersionContextError', async () => {
  const log: string[] = [];
  const conversation = makeConversation('鸿蒙和安卓都复现提交失败');
  const holder = new LazySourceHolder(fakeProvider(log), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙和安卓都复现提交失败',
    bind: async () => ({ workspace_path: '/should-not-happen' }),
  });
  const result = await executeTool(tool);
  assert.equal(result.status, 'unresolved');
  assert.equal(holder.bound, false);
  assert.deepEqual(log, []);
  // 缺口写回会话 source_limitations，供提示词展示。
  assert.ok(conversation.source_limitations.length > 0);
});

test('hint 参数并入解析输入（用户后续补充的版本号）', async () => {
  const conversation = makeConversation('鸿蒙端提交作业失败');
  const holder = new LazySourceHolder(fakeProvider([]), conversation.id);
  let seenInputVersion: string | null | undefined;
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙端提交作业失败',
    bind: async (input) => {
      seenInputVersion = input.version;
      return { workspace_path: '/snapshots/h', source_limitations: [] };
    },
  });
  const result = await executeTool(tool, { hint: '用户确认版本是 3.2.1' });
  assert.equal(seenInputVersion, '3.2.1');
  assert.equal(result.status, 'bound');
});
