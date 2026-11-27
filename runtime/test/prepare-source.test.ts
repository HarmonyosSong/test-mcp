import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareConversationSource } from '../src/capabilities/prepare-source.js';
import { VersionRegistryError } from '../src/capabilities/version-registry.js';
import { ConversationRecordSchema, type ConversationRecord } from '../src/domain/schemas.js';

const timestamp = '2026-11-26T00:00:00.000Z';

function makeConversation(content: string): ConversationRecord {
  return ConversationRecordSchema.parse({
    id: 'conv-prepare-src',
    title: 't',
    messages: [{ id: 'msg-1', role: 'user', content, created_at: timestamp }],
    created_at: timestamp,
    updated_at: timestamp,
  });
}

test('版本未登记失败：不抛错、写可读 limitation、保留解析出的 scope 供下轮沿用', async () => {
  const conversation = makeConversation('鸿蒙端7.105.0学而思app 点击跨报没有去结算按钮');
  await prepareConversationSource(conversation, conversation.messages[0]!.content, async () => {
    throw new VersionRegistryError('version_not_registered', '未配置 HARMONY_AGENT_GITLAB_TOKEN，无法查询发布 tag');
  });
  // 保留 scope 是既有设计：下轮「继续核查」沿同一版本重试，不重复向用户追问。
  assert.equal(conversation.platform, 'harmony');
  assert.equal(conversation.version, '7.105.0');
  assert.match(conversation.source_limitations[0] ?? '', /源码快照暂未绑定/);
  assert.match(conversation.source_limitations[0] ?? '', /GITLAB_TOKEN/);
});

test('物化层普通错误同样转可读 limitation，不裸抛（与显式绑定路径同一工具合同）', async () => {
  const conversation = makeConversation('鸿蒙端7.105.0学而思app 点击跨报没有去结算按钮');
  await prepareConversationSource(conversation, conversation.messages[0]!.content, async () => {
    throw new Error('git clone timeout');
  });
  assert.match(conversation.source_limitations[0] ?? '', /git clone timeout/);
});

test('下一轮文本给出新版本时按新版本重试（不被上轮残留绑架）', async () => {
  const conversation = makeConversation('鸿蒙端7.105.0学而思app 点击跨报没有去结算按钮');
  await prepareConversationSource(conversation, conversation.messages[0]!.content, async () => {
    throw new VersionRegistryError('version_not_registered', '没有 7.105.0');
  });
  conversation.messages.push({
    id: 'msg-2', role: 'user', content: '换成 7.106.0 试试', steps: [], status: 'completed',
    error: null, report: null, input_tokens: null, output_tokens: null,
    context_tokens: null, context_cache_read_tokens: null, analysis_feedback: null,
    tool_usage: {}, created_at: timestamp,
  });
  const boundInputs: Array<Record<string, unknown>> = [];
  await prepareConversationSource(conversation, conversation.messages[1]!.content, async (input) => {
    boundInputs.push(input as Record<string, unknown>);
    return { workspace_path: '/tmp/ws-2', version: input.version };
  });
  assert.equal(boundInputs[0]!.version, '7.106.0');
  assert.equal(conversation.version, '7.106.0');
});

test('内容无平台信息时不触发绑定', async () => {
  const conversation = makeConversation('支付失败怎么回事');
  let bindCalled = false;
  await prepareConversationSource(conversation, '支付失败怎么回事', async () => {
    bindCalled = true;
    return { workspace_path: '/tmp/ws' };
  });
  assert.equal(bindCalled, false);
  assert.equal(conversation.platform, null);
  assert.equal(conversation.form_factor, null);
  assert.equal(conversation.version, null);
});
