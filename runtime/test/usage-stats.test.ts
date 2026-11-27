import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationRecordSchema } from '../src/domain/schemas.js';
import { aggregateUsageStats } from '../src/usage/aggregate.js';
import {
  buildDigestMarkdown,
  buildDigestPageUrl,
  buildDigestTitle,
  rankFeedbackByUser,
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

test('digest markdown：归档统计按使用人（含没有结论档，未评价不进正确率）', () => {
  const stats = aggregateUsageStats([
    conversation({
      id: 'a',
      channel: 'yach_im',
      owner_subject: '10001',
      owner_display_name: '老师甲',
      messages: [
        { role: 'user', content: 'q1', created_at: '2026-11-26T02:00:00.000Z' },
        {
          role: 'assistant',
          content: '判定：已定位\n直接原因：x',
          status: 'completed',
          created_at: '2026-11-26T02:05:00.000Z',
          analysis_feedback: { verdict: 'correct', by_work_code: '20001', by_name: '宋一博', at: '2026-11-26T03:00:00.000Z' },
        },
      ],
    }),
    conversation({
      id: 'b',
      channel: 'yach_im',
      owner_subject: '10001',
      owner_display_name: '老师甲',
      messages: [
        { role: 'user', content: 'q2', created_at: '2026-11-26T03:00:00.000Z' },
        {
          role: 'assistant',
          content: '判定：已定位\n直接原因：y',
          status: 'completed',
          created_at: '2026-11-26T03:05:00.000Z',
          analysis_feedback: { verdict: 'vague', by_work_code: '20001', by_name: '宋一博', at: '2026-11-26T03:30:00.000Z' },
        },
      ],
    }),
    conversation({
      id: 'c',
      channel: 'yach_im',
      owner_subject: '20002',
      owner_display_name: null,
      messages: [
        { role: 'user', content: 'q3', created_at: '2026-11-26T04:00:00.000Z' },
        {
          role: 'assistant',
          content: '判定：已定位\n直接原因：z',
          status: 'completed',
          created_at: '2026-11-26T04:05:00.000Z',
          analysis_feedback: { verdict: 'failed', by_work_code: '20002', by_name: null, at: '2026-11-26T04:30:00.000Z' },
        },
      ],
    }),
    conversation({
      id: 'd',
      channel: 'web',
      owner_subject: '999',
      messages: [
        { role: 'user', content: 'q4 无归档', created_at: '2026-11-26T05:00:00.000Z' },
        {
          role: 'assistant',
          content: '判定：可能定位\n直接原因：w',
          status: 'completed',
          created_at: '2026-11-26T05:05:00.000Z',
          analysis_feedback: null,
        },
      ],
    }),
  ], '2026-11-26', '2026-11-26', TZ);

  const ranks = rankFeedbackByUser(stats.items);
  // 使用人维度：提过问题的人都进表（含没有结论的 999）
  assert.equal(ranks.length, 3);
  assert.equal(ranks[0]?.name, '老师甲');
  assert.equal(ranks[0]?.correct, 1);
  assert.equal(ranks[0]?.vague, 1);
  assert.equal(ranks[0]?.failed, 0);
  assert.equal(ranks[0]?.unconcluded, 0);
  assert.equal(ranks[0]?.total, 2);
  assert.equal(ranks[0]?.accuracy, 0.5);
  // display_name 为空时兜底工号
  assert.equal(ranks[1]?.name, '20002');
  assert.equal(ranks[1]?.failed, 1);
  assert.equal(ranks[1]?.accuracy, 0);
  // 无归档评价的会话计入「没有结论」，正确率为 null（不参与）
  assert.equal(ranks[2]?.name, '999');
  assert.equal(ranks[2]?.unconcluded, 1);
  assert.equal(ranks[2]?.accuracy, null);

  assert.equal(buildDigestTitle('2026-11-26'), '问题排查助手每日使用统计(2026-11-26)');
  const pageUrl = buildDigestPageUrl(
    { publicBaseUrl: 'https://example.com', appPrefix: '/xesapp-agent' },
    '2026-11-26',
  );
  assert.equal(pageUrl, 'https://example.com/xesapp-agent/usage?date=2026-11-26');
  const md = buildDigestMarkdown(stats, pageUrl);
  assert.match(md, /^\*\*问题排查助手每日使用统计\(2026-11-26\)\*\*/m);
  // 概要行：使用量 + 归档条数（只计已评价）
  assert.match(md, /当日使用 3 人、4 个会话；归档反馈 3 条/);
  // 归档表格：姓名/三档/没有结论/合计/正确率
  assert.match(md, /\| 姓名 \| 分析正确 \| 分析模糊 \| 分析失败 \| 没有结论 \| 合计 \| 正确率 \|/);
  assert.match(md, /\| 老师甲 \| 1 \| 1 \| 0 \| 0 \| 2 \| 50\.0% \|/);
  assert.match(md, /\| 20002 \| 0 \| 0 \| 1 \| 0 \| 1 \| 0\.0% \|/);
  assert.match(md, /\| 999 \| 0 \| 0 \| 0 \| 1 \| 1 \| — \|/);
  // 合计行：正确率 = 正确/已评价 = 1/3（没有结论不进分母）
  assert.match(md, /\| 合计 \| 1 \| 1 \| 1 \| 1 \| 4 \| 33\.3% \|/);
  assert.match(md, /查看详情/);
});

test('digest markdown：当日全部未归档时正确率显示 —', () => {
  const stats = aggregateUsageStats([
    conversation({
      id: 'a',
      channel: 'web',
      owner_subject: '999',
      messages: [
        { role: 'user', content: 'q', created_at: '2026-11-26T02:00:00.000Z' },
        { role: 'assistant', content: '判定：可能定位\nx', status: 'completed', created_at: '2026-11-26T02:05:00.000Z', analysis_feedback: null },
      ],
    }),
  ], '2026-11-26', '2026-11-26', TZ);
  const md = buildDigestMarkdown(stats, 'https://example.com/usage?date=2026-11-26');
  assert.match(md, /归档反馈 0 条/);
  assert.match(md, /\| 999 \| 0 \| 0 \| 0 \| 1 \| 1 \| — \|/);
  assert.match(md, /\| 合计 \| 0 \| 0 \| 0 \| 1 \| 1 \| — \|/);
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
