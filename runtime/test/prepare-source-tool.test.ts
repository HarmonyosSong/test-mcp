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

function executeTool(
  tool: ReturnType<typeof createPrepareSourceTool>,
  args: { hint?: string; platform?: 'harmony' | 'android' | 'ios'; version?: string } = {},
) {
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
  assert.equal(holder.bound(), true);
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
  assert.equal(holder.bound(), false);
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
  assert.equal(holder.bound(), false);
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

/** 构造已确定事故范围的会话（平台/产品线/版本 + 已绑定事故端快照）。 */
function makeIncidentConversation() {
  const conversation = makeConversation('鸿蒙 7.106.0 跨报成功记录不展示去结算');
  conversation.platform = 'harmony';
  conversation.product_line = 'xueersi';
  conversation.version = '7.106.0';
  conversation.workspace_path = '/snapshots/harmony-7.106.0';
  conversation.repository_id = 'repo-harmony';
  conversation.repository_name = 'xesapp-harmony';
  conversation.requested_ref = '7.106.0';
  conversation.resolved_commit = 'harmonycommit';
  conversation.source_repositories = [{
    repository_id: 'repo-harmony',
    repository_name: 'xesapp-harmony',
    requested_ref: '7.106.0',
    resolved_commit: 'harmonycommit',
    role: 'shell',
    mount_path: '',
  }];
  return conversation;
}

test('对照端绑定：显式不同 platform 写 compare_source，事故 scope 不变', async () => {
  const log: string[] = [];
  const conversation = makeIncidentConversation();
  const holder = new LazySourceHolder(fakeProvider(log), conversation.id);
  let bindInput: Record<string, unknown> | null = null;
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙 7.106.0 跨报成功记录不展示去结算',
    bind: async (input) => {
      bindInput = input as unknown as Record<string, unknown>;
      return {
        workspace_path: '/snapshots/ios-7.106.0',
        repository_id: 'repo-ios',
        repository_name: 'xesapp-ios',
        requested_ref: 'xueersi_v7.106.0_1000_20261101',
        resolved_commit: 'ioscommit',
        platform: 'ios',
        product_line: 'xueersi',
        form_factor: null,
        version: '7.106.0',
        build: null,
        source_repositories: [{
          repository_id: 'repo-ios',
          repository_name: 'xesapp-ios',
          requested_ref: 'xueersi_v7.106.0_1000_20261101',
          resolved_commit: 'ioscommit',
          role: 'shell',
          mount_path: '',
        }],
        source_completeness: 'partial',
        source_limitations: ['当前仅绑定主工程，组件源码未挂载；具体缺口见下方。'],
      };
    },
  });
  const result = await executeTool(tool, { platform: 'ios' });
  assert.equal(result.status, 'bound_compare');
  // 版本缺省取事故版本号
  assert.equal(bindInput!.platform, 'ios');
  assert.equal(bindInput!.version, '7.106.0');
  assert.equal(bindInput!.productLine, 'xueersi');
  // 事故 scope 一字不动
  assert.equal(conversation.platform, 'harmony');
  assert.equal(conversation.version, '7.106.0');
  assert.equal(conversation.workspace_path, '/snapshots/harmony-7.106.0');
  assert.equal(conversation.source_repositories[0]?.repository_id, 'repo-harmony');
  // 对照端写入独立字段并热绑定 compare 槽位
  assert.equal(conversation.compare_source?.platform, 'ios');
  assert.equal(conversation.compare_source?.resolved_commit, 'ioscommit');
  assert.equal(holder.bound('compare'), true);
  assert.deepEqual(log, ['bind:/snapshots/ios-7.106.0']);
  const compare = result.compare as { version: string; source_limitations: string[] };
  assert.equal(compare.version, '7.106.0');
  assert.ok(Array.isArray(compare.source_limitations));
});

test('显式平台绑定：事故平台未定时直接绑为事故端，绕过文本解析', async () => {
  const log: string[] = [];
  // 多平台文本：裸调必然歧义失败（见「平台歧义」用例），显式 platform 是唯一推进路径。
  const conversation = makeConversation('ios 安卓现在userinfo的接口 talModifiTime 字段入参是怎么给的');
  const holder = new LazySourceHolder(fakeProvider(log), conversation.id);
  const bindInputs: Record<string, unknown>[] = [];
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: 'ios 安卓现在userinfo的接口 talModifiTime 字段入参是怎么给的',
    bind: async (input) => {
      bindInputs.push(input as unknown as Record<string, unknown>);
      if (input.platform === 'android') {
        return {
          workspace_path: '/snapshots/android-latest',
          repository_id: 'repo-android',
          repository_name: 'xesapp-android',
          requested_ref: 'xueersi_v7.106.0_20261101',
          resolved_commit: 'androidcommit',
          platform: 'android',
          product_line: 'xueersi',
          form_factor: null,
          version: '7.106.0',
          build: null,
          source_repositories: [{
            repository_id: 'repo-android',
            repository_name: 'xesapp-android',
            requested_ref: 'xueersi_v7.106.0_20261101',
            resolved_commit: 'androidcommit',
            role: 'shell',
            mount_path: '',
          }],
          source_completeness: 'partial',
          source_limitations: [],
        };
      }
      return {
        workspace_path: '/snapshots/ios-latest',
        platform: 'ios',
        product_line: 'xueersi',
        version: '7.106.0',
        source_repositories: [{
          repository_id: 'repo-ios',
          repository_name: 'xesapp-ios',
          requested_ref: 'xueersi_v7.106.0_1000_20261101',
          resolved_commit: 'ioscommit',
          role: 'shell',
          mount_path: '',
        }],
        source_completeness: 'partial',
        source_limitations: ['未登记指定版本时回落最近已登记版本。'],
      };
    },
  });
  const result = await executeTool(tool, { platform: 'ios' });
  assert.equal(result.status, 'bound');
  assert.equal(result.explicit, true);
  // 显式参数直达 bind：不经过文本解析，版本保持会话原值（空），产品线按默认学而思兜底。
  assert.equal(bindInputs[0]!.platform, 'ios');
  assert.equal(bindInputs[0]!.productLine, 'xueersi');
  assert.equal(bindInputs[0]!.version, null);
  // 事故端 scope 被写入：该端自此成为事故端，登记表解析出的产品线一并落库。
  assert.equal(conversation.platform, 'ios');
  assert.equal(conversation.product_line, 'xueersi');
  assert.equal(conversation.workspace_path, '/snapshots/ios-latest');
  assert.equal(conversation.version, '7.106.0');
  assert.equal(holder.bound(), true);

  // 链式：再传另一个 platform，自动走对照端分支（版本缺省沿用事故版本号）。
  const second = await executeTool(tool, { platform: 'android' });
  assert.equal(second.status, 'bound_compare');
  assert.equal(bindInputs[1]!.platform, 'android');
  assert.equal(bindInputs[1]!.productLine, 'xueersi');
  assert.equal(bindInputs[1]!.version, '7.106.0');
  assert.equal(conversation.compare_source?.platform, 'android');
  assert.equal(holder.bound('compare'), true);
  // 事故端（ios）一字不动。
  assert.equal(conversation.platform, 'ios');
  assert.equal(conversation.workspace_path, '/snapshots/ios-latest');
  assert.deepEqual(log, ['bind:/snapshots/ios-latest', 'bind:/snapshots/android-latest']);
});

test('显式平台绑定物化失败：返回缺口文本而不抛错（工具合同）', async () => {
  const conversation = makeConversation('ios 安卓现在userinfo的接口字段入参是怎么给的');
  const holder = new LazySourceHolder(fakeProvider([]), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: 'ios 安卓现在userinfo的接口字段入参是怎么给的',
    bind: async () => {
      throw new Error('registry unreachable');
    },
  });
  const result = await executeTool(tool, { platform: 'ios' });
  assert.equal(result.status, 'unresolved');
  assert.match(String(result.limitation), /绑定失败/);
  assert.equal(conversation.platform, null);
  assert.equal(holder.bound(), false);
});

test('对照端与事故平台相同：走事故端流程（不触发对照绑定）', async () => {  const conversation = makeIncidentConversation();
  const holder = new LazySourceHolder(fakeProvider([]), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙 7.106.0 跨报成功记录不展示去结算',
    bind: async () => {
      throw new Error('已绑定完整事故端快照时不应重新物化');
    },
  });
  const result = await executeTool(tool, { platform: 'harmony' });
  assert.equal(result.status, 'bound');
  assert.equal(conversation.compare_source, null);
});

test('对照端缺产品线：返回缺口说明，不抛错', async () => {
  const conversation = makeIncidentConversation();
  conversation.product_line = null;
  const holder = new LazySourceHolder(fakeProvider([]), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙 7.106.0 跨报成功记录不展示去结算',
    bind: async () => ({ workspace_path: '/should-not-happen' }),
  });
  const result = await executeTool(tool, { platform: 'ios' });
  assert.equal(result.status, 'unresolved');
  assert.match(String(result.limitation), /产品线/);
  assert.equal(conversation.compare_source, null);
});

test('对照端物化失败：返回缺口文本而不抛错（工具合同）', async () => {
  const conversation = makeIncidentConversation();
  const holder = new LazySourceHolder(fakeProvider([]), conversation.id);
  const tool = createPrepareSourceTool({
    conversation,
    holder,
    content: '鸿蒙 7.106.0 跨报成功记录不展示去结算',
    bind: async () => {
      throw new Error('GitLab 仓库没有匹配发布 tag');
    },
  });
  const result = await executeTool(tool, { platform: 'android' });
  assert.equal(result.status, 'unresolved');
  assert.match(String(result.limitation), /对照端 android 快照绑定失败/);
  assert.equal(conversation.compare_source, null);
});

