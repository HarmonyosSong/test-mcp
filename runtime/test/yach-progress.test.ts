import assert from 'node:assert/strict';
import test from 'node:test';

import {
  logSourceForTool,
  progressLabelForStreamEvent,
  progressLabelForTool,
  progressStepForTool,
} from '../src/channels/yach/progress-map.js';
import { YachProgressCard, type YachCardApi } from '../src/channels/yach/progress.js';

test('progressStepForTool 区分学员/源码/知识/协查/远程日志', () => {
  assert.equal(progressStepForTool('lookup_learner'), 'learner');
  assert.equal(progressStepForTool('search_project_text'), 'source');
  assert.equal(progressStepForTool('search_knowledge'), 'knowledge');
  assert.equal(progressStepForTool('prepare_source'), 'source');
  assert.equal(progressStepForTool('consult_compass'), 'consult');
  assert.equal(progressStepForTool('search_both_logs'), 'logs');
  assert.equal(progressStepForTool('query'), 'logs');
  assert.equal(progressStepForTool('cloud_search'), 'logs');
  assert.equal(progressLabelForTool('lookup_learner'), '正在查询学员信息');
  assert.equal(progressLabelForTool('prepare_source'), '正在绑定源码快照');
  assert.equal(progressLabelForTool('consult_compass'), '正在请求服务端协查');
});

test('logSourceForTool 按工具名区分日志中心 / 阿里云 SLS / 两侧', () => {
  // 日志中心（ES/Lucene）
  for (const tool of [
    'search_services',
    'list_services',
    'get_fields',
    'get_storage_type',
    'count',
    'query',
    'dsl_search',
  ]) {
    assert.equal(logSourceForTool(tool), 'logcenter', tool);
  }
  // 阿里云 SLS
  for (const tool of [
    'cloud_accounts',
    'cloud_collections',
    'cloud_topics',
    'cloud_count',
    'cloud_search',
    'cloud_probe',
  ]) {
    assert.equal(logSourceForTool(tool), 'cloud', tool);
  }
  // 聚合工具：两侧并行
  assert.equal(logSourceForTool('search_both_logs'), 'both');
  // 非日志工具不应误判
  assert.equal(logSourceForTool('read_project_file'), null);
  assert.equal(logSourceForTool('lookup_learner'), null);
});

test('logSourceForTool 兼容带服务前缀的工具名，且不误吞别的 MCP 后缀', () => {
  assert.equal(logSourceForTool('log.cloud_search'), 'cloud');
  assert.equal(logSourceForTool('log_cloud_count'), 'cloud');
  assert.equal(logSourceForTool('log-query'), null);
  assert.equal(logSourceForTool('log_query'), 'logcenter');
  assert.equal(logSourceForTool('log_search_both_logs'), 'both');
  // 别的 MCP 的通用名不能被当成日志工具
  assert.equal(logSourceForTool('other_count'), null);
  assert.equal(logSourceForTool('tool_query'), null);
});

test('进度文案按日志来源分三档，不再统一写「远程日志」', () => {
  assert.equal(progressLabelForTool('query'), '正在查询日志中心');
  assert.equal(progressLabelForTool('dsl_search'), '正在查询日志中心');
  assert.equal(progressLabelForTool('cloud_search'), '正在查询阿里云 SLS 日志');
  assert.equal(progressLabelForTool('cloud_probe'), '正在查询阿里云 SLS 日志');
  assert.equal(progressLabelForTool('search_both_logs'), '正在同时查询日志中心与云日志');
});

test('progressLabelForStreamEvent 只产出动态状态文案', () => {
  assert.equal(
    progressLabelForStreamEvent({ type: 'tool-start', event: { tool: 'lookup_learner' } as never }),
    '正在查询学员信息',
  );
  assert.equal(progressLabelForStreamEvent({ type: 'text', delta: '结论' }), '正在整理结论');
  assert.equal(
    progressLabelForStreamEvent({ type: 'failed', error: 'boom', failure_category: 'runtime_error' } as never),
    '诊断失败',
  );
  assert.equal(
    progressLabelForStreamEvent({ type: 'tool-end', event: { tool: 'lookup_learner' } as never, evidence_state: {} }),
    null,
  );
});

test('进度卡首屏不含固定任务清单，只有动态状态行', async () => {
  const pushed: string[] = [];
  const api: YachCardApi = {
    async createCard() {
      return 'card-1';
    },
    async pushCard(_cardId, content) {
      pushed.push(content);
    },
    async closeCard() {},
  };
  const card = new YachProgressCard(api, { toId: 'user-1', conversationType: '1' });
  card.onStreamEvent({ type: 'tool-start', event: { tool: 'lookup_learner' } as never });
  await card.finish('诊断完成');

  const all = pushed.join('\n');
  assert.doesNotMatch(all, /○/);
  assert.doesNotMatch(all, /已完成 \d\/\d/);
  assert.doesNotMatch(all, /检索线上日志/);
  assert.doesNotMatch(all, /核对源码线索/);
  assert.doesNotMatch(all, /诊断进度/);
  assert.match(all, /正在查询学员信息/);
  assert.match(all, /\*\*诊断完成\*\*/);
});

test('YachProgressCard 建卡/追加/关卡，失败不抛出', async () => {
  const calls: string[] = [];
  const api: YachCardApi = {
    async createCard(target) {
      calls.push(`create:${target.toId}`);
      return 'card-1';
    },
    async pushCard(cardId, content) {
      calls.push(`push:${cardId}:${content.slice(0, 40)}`);
    },
    async closeCard(cardId) {
      calls.push(`close:${cardId}`);
    },
  };
  const card = new YachProgressCard(api, { toId: 'user-1', conversationType: '1' });
  card.onStreamEvent({
    type: 'tool-start',
    event: { tool: 'lookup_learner' } as never,
  });
  await card.finish('诊断完成');
  assert.ok(calls.some((line) => line.startsWith('create:')));
  assert.ok(calls.some((line) => line.startsWith('push:')));
  assert.ok(calls.some((line) => line === 'close:card-1'));
});

test('进度卡 API 失败不影响 finish 返回', async () => {
  const api: YachCardApi = {
    async createCard() {
      throw new Error('network');
    },
    async pushCard() {},
    async closeCard() {},
  };
  const card = new YachProgressCard(api, { toId: 'user-1', conversationType: '1' });
  await card.finish('诊断失败');
});
