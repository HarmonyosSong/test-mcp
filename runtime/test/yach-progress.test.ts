import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProgressEvent,
  createProgressChecklist,
  progressLabelForTool,
  progressStepForTool,
  renderProgressChecklist,
} from '../src/channels/yach/progress-map.js';
import { YachProgressCard, type YachCardApi } from '../src/channels/yach/progress.js';

test('progressStepForTool 区分学员/日志/源码/知识/协查', () => {
  assert.equal(progressStepForTool('lookup_learner'), 'learner');
  assert.equal(progressStepForTool('resolve_log_target'), 'logs');
  assert.equal(progressStepForTool('search_cloud_logs'), 'logs');
  assert.equal(progressStepForTool('search_project_text'), 'source');
  assert.equal(progressStepForTool('search_knowledge'), 'knowledge');
  assert.equal(progressStepForTool('prepare_source'), 'source');
  assert.equal(progressStepForTool('consult_compass'), 'consult');
  assert.equal(progressLabelForTool('lookup_learner'), '正在查询学员信息');
  assert.equal(progressLabelForTool('prepare_source'), '正在绑定源码快照');
  assert.equal(progressLabelForTool('consult_compass'), '正在请求外部协查');
});

test('applyProgressEvent 按工具起止勾选清单', () => {
  let state = createProgressChecklist();
  let applied = applyProgressEvent(state, {
    type: 'tool-start',
    event: { tool: 'lookup_learner' } as never,
  });
  assert.equal(applied.checklist.learner, 'active');
  assert.match(applied.label ?? '', /学员/);

  applied = applyProgressEvent(applied.checklist, {
    type: 'tool-end',
    event: { tool: 'lookup_learner' } as never,
    evidence_state: {},
  });
  assert.equal(applied.checklist.learner, 'done');

  applied = applyProgressEvent(applied.checklist, { type: 'text', delta: '结论' });
  assert.equal(applied.checklist.report, 'active');

  applied = applyProgressEvent(applied.checklist, {
    type: 'completed',
    text: 'ok',
    report: null,
    verdict: null,
    evidence_state: {},
    messages_state: [],
    input_tokens: null,
    output_tokens: null,
    tool_usage: {},
  });
  assert.equal(applied.checklist.report, 'done');
});

test('renderProgressChecklist 输出任务进度摘要', () => {
  const checklist = createProgressChecklist();
  checklist.learner = 'done';
  checklist.logs = 'active';
  const text = renderProgressChecklist(checklist, '正在查询远程日志', 12);
  assert.match(text, /已完成 1\/6/);
  assert.match(text, /✓ 查询学员信息/);
  assert.match(text, /→ 检索线上日志/);
  assert.match(text, /正在查询远程日志（12 秒）/);
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
  card.onStreamEvent({
    type: 'tool-end',
    event: { tool: 'lookup_learner' } as never,
    evidence_state: {},
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
