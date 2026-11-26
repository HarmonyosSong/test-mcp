import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateYachFeedback, parseStatsWindow } from '../src/http/yach-feedback.js';
import type { ChatMessage, ConversationRecord } from '../src/domain/schemas.js';

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '判定：已定位\n【问题原因】…',
    steps: [],
    status: 'completed',
    error: null,
    report: null,
    input_tokens: null,
    output_tokens: null,
    context_tokens: null,
    context_cache_read_tokens: null,
    analysis_feedback: null,
    tool_usage: {},
    created_at: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

function conversation(id: string, channel: 'web' | 'yach_im', messages: ChatMessage[]): ConversationRecord {
  return {
    id,
    title: id,
    channel,
    owner_subject: 'owner',
    messages,
    created_at: '2026-11-20T09:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z',
  } as ConversationRecord;
}

const WINDOW = { from: null, toInclusive: null, fromRaw: null, toRaw: null };

test('聚合：只统计知音楼会话的故障终稿，按归档人分组算正确率', () => {
  const conversations = [
    conversation('c1', 'yach_im', [
      message('m1', {
        analysis_feedback: { verdict: 'correct', by_work_code: 'zhangsan', by_name: '张三', at: '2026-11-20T11:00:00.000Z' },
      }),
      message('m2', {
        analysis_feedback: { verdict: 'failed', by_work_code: 'zhangsan', by_name: '张三', at: '2026-11-20T12:00:00.000Z' },
      }),
      // 未归档终稿：计入 final_answers，不进 archived。
      message('m3'),
      // 初步判定不是终稿，不参与统计。
      message('m4', { content: '判定：可能定位（初步）\n协查在途。' }),
      // 信息查询不参与统计。
      message('m5', { content: '判定：信息查询\n【学员信息】…' }),
    ]),
    // web 渠道会话即使有终稿形态也不统计（归档是知音楼场景）。
    conversation('c2', 'web', [
      message('m6', {
        analysis_feedback: { verdict: 'correct', by_work_code: 'lisi', by_name: '李四', at: '2026-11-20T11:00:00.000Z' },
      }),
    ]),
  ];

  const stats = aggregateYachFeedback(conversations, WINDOW);
  assert.deepEqual(stats.totals, {
    final_answers: 3,
    archived: 2,
    correct: 1,
    failed: 1,
    unarchived: 1,
    accuracy: 0.5,
  });
  assert.deepEqual(stats.by_user, [
    { work_code: 'zhangsan', name: '张三', correct: 1, failed: 1, total: 2 },
  ]);
});

test('聚合：时间窗按消息创建时间过滤（闭区间），无归档时 accuracy 为 null', () => {
  const conversations = [
    conversation('c1', 'yach_im', [
      message('old', { created_at: '2026-10-01T10:00:00.000Z' }),
      message('in-range', {
        created_at: '2026-11-20T10:00:00.000Z',
        analysis_feedback: { verdict: 'failed', by_work_code: null, by_name: null, at: '2026-11-20T11:00:00.000Z' },
      }),
      message('new', { created_at: '2026-12-01T10:00:00.000Z' }),
    ]),
  ];

  const window = parseStatsWindow('2026-11-01', '2026-11-30');
  assert.ok(window);
  const stats = aggregateYachFeedback(conversations, window);
  assert.equal(stats.totals.final_answers, 1);
  assert.equal(stats.totals.failed, 1);
  assert.equal(stats.totals.accuracy, 0);
  // 归档人缺失时归入「(未知)」组。
  assert.equal(stats.by_user[0]?.work_code, null);

  const empty = aggregateYachFeedback(conversations, parseStatsWindow('2026-10-02', '2026-10-03')!);
  assert.equal(empty.totals.final_answers, 0);
  assert.equal(empty.totals.accuracy, null);
});

test('时间窗参数：非法日期返回 null；to 补到当天末尾', () => {
  assert.equal(parseStatsWindow('not-a-date', null), null);
  assert.equal(parseStatsWindow(null, '2026-13-01'), null);
  const window = parseStatsWindow(null, '2026-11-30');
  assert.ok(window);
  // 当天 23:59:59.999 仍在窗口内。
  assert.ok(window.toInclusive!.getTime() >= new Date('2026-11-30T23:59:59.000Z').getTime());
});
