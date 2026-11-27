import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationRecordSchema } from '../src/domain/schemas.js';
import { aggregateUsageStats } from '../src/usage/aggregate.js';
import {
  buildDigestMarkdown,
  buildDigestPageUrl,
  buildDigestTitle,
  rankUsageByUser,
} from '../src/usage/digest-push.js';
import { calendarDateInTimeZone, isValidDateYmd, yesterdayYmd } from '../src/usage/day.js';
import { resolveUsageRangePreset } from '../src/usage/routes.js';
import { nextCronFire, parseDailyCron } from '../src/usage/scheduler.js';

const TZ = 'Asia/Shanghai';

function conversation(input: Record<string, unknown>) {
  return ConversationRecordSchema.parse(input);
}

test('isValidDateYmd rejects bad dates', () => {
  assert.equal(isValidDateYmd('2026-11-26'), true);
  assert.equal(isValidDateYmd('2026-13-01'), false);
  assert.equal(isValidDateYmd('nope'), false);
});

test('parseDailyCron accepts minute hour only', () => {
  assert.deepEqual(parseDailyCron('40 9 * * *'), { minute: 40, hour: 9 });
  assert.equal(parseDailyCron('40 9 * * 1'), null);
});

test('nextCronFire schedules after now', () => {
  const from = new Date('2026-11-26T01:00:00.000Z'); // 09:00 Shanghai
  const next = nextCronFire('40 9 * * *', TZ, from);
  assert.ok(next);
  assert.ok(next!.getTime() > from.getTime());
  assert.equal(calendarDateInTimeZone(next!, TZ), '2026-11-26');
});

test('aggregateUsageStats counts users questions verdicts and feedback', () => {
  const day = '2026-11-26';
  const conversations = [
    conversation({
      id: 'c1',
      title: 'web case',
      channel: 'web',
      owner_subject: '347273',
      owner_display_name: '测试用户',
      messages: [
        {
          role: 'user',
          content: '学员打不开直播课',
          created_at: '2026-11-26T02:00:00.000Z',
        },
        {
          role: 'assistant',
          content: '判定：可能定位\n直接原因：示例',
          status: 'completed',
          created_at: '2026-11-26T02:05:00.000Z',
          analysis_feedback: null,
        },
      ],
    }),
    conversation({
      id: 'c2',
      title: 'yach case',
      channel: 'yach_im',
      owner_subject: '10001',
      owner_display_name: '老师甲',
      messages: [
        {
          role: 'user',
          content: '登录失败',
          created_at: '2026-11-26T03:00:00.000Z',
        },
        {
          role: 'assistant',
          content: '判定：已定位\n直接原因：token 过期',
          status: 'completed',
          created_at: '2026-11-26T03:10:00.000Z',
          analysis_feedback: {
            verdict: 'correct',
            by_work_code: '10002',
            by_name: '归档人',
            at: '2026-11-26T04:00:00.000Z',
          },
        },
      ],
    }),
    conversation({
      id: 'c3',
      title: 'other day',
      channel: 'web',
      owner_subject: '999',
      messages: [
        {
          role: 'user',
          content: '昨天的问题',
          created_at: '2026-11-25T02:00:00.000Z',
        },
      ],
    }),
  ];

  const stats = aggregateUsageStats(conversations, day, day, TZ);
  assert.equal(stats.from, day);
  assert.equal(stats.to, day);
  assert.equal(stats.summary.unique_users, 2);
  assert.equal(stats.summary.conversations, 2);
  assert.equal(stats.summary.with_verdict, 2);
  assert.equal(stats.summary.feedback.correct, 1);
  assert.equal(stats.summary.feedback.none, 1);
  assert.equal(stats.items[0]?.owner_display_name, '老师甲');
  assert.equal(stats.items[1]?.verdict, '可能定位');
});

test('digest markdown ranks by usage count; name falls back to work code', () => {
  const stats = aggregateUsageStats([
    conversation({
      id: 'a',
      channel: 'web',
      owner_subject: '10001',
      owner_display_name: '老师甲',
      messages: [
        { role: 'user', content: 'q1', created_at: '2026-11-26T02:00:00.000Z' },
        { role: 'user', content: 'q1b', created_at: '2026-11-26T02:10:00.000Z' },
      ],
    }),
    conversation({
      id: 'b',
      channel: 'web',
      owner_subject: '10001',
      owner_display_name: '老师甲',
      messages: [
        { role: 'user', content: 'q2', created_at: '2026-11-26T03:00:00.000Z' },
      ],
    }),
    conversation({
      id: 'c',
      channel: 'yach_im',
      owner_subject: '20002',
      owner_display_name: null,
      messages: [
        { role: 'user', content: 'q3', created_at: '2026-11-26T04:00:00.000Z' },
      ],
    }),
  ], '2026-11-26', '2026-11-26', TZ);

  const ranks = rankUsageByUser(stats.items);
  assert.equal(ranks[0]?.work_code, '10001');
  assert.equal(ranks[0]?.name, '老师甲');
  assert.equal(ranks[0]?.count, 2);
  assert.equal(ranks[1]?.work_code, '20002');
  assert.equal(ranks[1]?.name, '20002');
  assert.equal(ranks[1]?.count, 1);

  assert.equal(buildDigestTitle('2026-11-26'), '问题排查助手每日使用统计(2026-11-26)');
  const pageUrl = buildDigestPageUrl(
    { publicBaseUrl: 'https://example.com', appPrefix: '/xesapp-agent' },
    '2026-11-26',
  );
  assert.equal(pageUrl, 'https://example.com/xesapp-agent/usage?date=2026-11-26');
  const md = buildDigestMarkdown(stats, pageUrl);
  assert.match(md, /^\*\*问题排查助手每日使用统计\(2026-11-26\)\*\*/m);
  assert.doesNotMatch(md, /合计/);
  assert.match(md, /\| 姓名 \| 工号 \| 使用次数 \|/);
  assert.match(md, /\| 老师甲 \| 10001 \| 2 \|/);
  assert.match(md, /\| 20002 \| 20002 \| 1 \|/);
  assert.match(md, /查看详情/);
});

test('yesterdayYmd differs from today', () => {
  const today = calendarDateInTimeZone(new Date(), TZ);
  const y = yesterdayYmd(TZ);
  assert.notEqual(y, today);
  assert.ok(isValidDateYmd(y));
});

test('resolveUsageRangePreset shifts window by preset', () => {
  const now = new Date('2026-11-27T04:00:00.000Z');
  assert.deepEqual(resolveUsageRangePreset('today', TZ, now), {
    from: '2026-11-27',
    to: '2026-11-27',
  });
  assert.deepEqual(resolveUsageRangePreset('yesterday', TZ, now), {
    from: '2026-11-26',
    to: '2026-11-26',
  });
  assert.deepEqual(resolveUsageRangePreset('3d', TZ, now), {
    from: '2026-11-25',
    to: '2026-11-27',
  });
  assert.deepEqual(resolveUsageRangePreset('7d', TZ, now), {
    from: '2026-11-21',
    to: '2026-11-27',
  });
});
