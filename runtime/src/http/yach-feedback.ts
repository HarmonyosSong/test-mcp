import { Hono } from 'hono';
import type { ProductStore } from '../product/store.js';
import type { ConversationRecord } from '../domain/schemas.js';
import { isFaultFinalAnswer } from '../channels/yach/archive.js';

/**
 * 问题归档统计（知音楼评测集）：按时间窗聚合故障终稿数与支持老师归档的正确/失败数。
 * GET /api/yach-feedback/stats?from=2026-11-01&to=2026-11-30（from/to 可选，按消息 created_at 过滤，闭区间）
 */

export interface YachFeedbackStats {
  range: { from: string | null; to: string | null };
  totals: {
    final_answers: number;
    archived: number;
    correct: number;
    vague: number;
    failed: number;
    unarchived: number;
    /** 归档正确率 = correct / archived（模糊计为未达标）；无归档时为 null。 */
    accuracy: number | null;
  };
  by_user: Array<{
    work_code: string | null;
    name: string | null;
    correct: number;
    vague: number;
    failed: number;
    total: number;
  }>;
}

export interface StatsWindow {
  from: Date | null;
  /** 已补到当天末尾的闭区间上界。 */
  toInclusive: Date | null;
  fromRaw: string | null;
  toRaw: string | null;
}

/** 聚合纯函数：仅统计知音楼渠道会话的故障终稿与归档回写。 */
export function aggregateYachFeedback(
  conversations: ConversationRecord[],
  window: StatsWindow,
): YachFeedbackStats {
  const totals = { final_answers: 0, archived: 0, correct: 0, vague: 0, failed: 0 };
  const byUser = new Map<string, { work_code: string | null; name: string | null; correct: number; vague: number; failed: number }>();

  for (const conversation of conversations) {
    if (conversation.channel !== 'yach_im') continue;
    for (const message of conversation.messages) {
      if (message.role !== 'assistant' || !isFaultFinalAnswer(message.content)) continue;
      const created = new Date(message.created_at);
      if (Number.isNaN(created.getTime())) continue;
      if (window.from && created < window.from) continue;
      if (window.toInclusive && created > window.toInclusive) continue;
      totals.final_answers += 1;
      const feedback = message.analysis_feedback;
      if (!feedback) continue;
      totals.archived += 1;
      if (feedback.verdict === 'correct') totals.correct += 1;
      else if (feedback.verdict === 'vague') totals.vague += 1;
      else totals.failed += 1;
      const key = feedback.by_work_code ?? feedback.by_name ?? '(未知)';
      const bucket = byUser.get(key) ?? {
        work_code: feedback.by_work_code,
        name: feedback.by_name,
        correct: 0,
        vague: 0,
        failed: 0,
      };
      if (feedback.verdict === 'correct') bucket.correct += 1;
      else if (feedback.verdict === 'vague') bucket.vague += 1;
      else bucket.failed += 1;
      byUser.set(key, bucket);
    }
  }

  return {
    range: { from: window.fromRaw, to: window.toRaw },
    totals: {
      ...totals,
      unarchived: totals.final_answers - totals.archived,
      accuracy: totals.archived > 0 ? totals.correct / totals.archived : null,
    },
    by_user: [...byUser.values()]
      .map((bucket) => ({ ...bucket, total: bucket.correct + bucket.vague + bucket.failed }))
      .sort((a, b) => b.total - a.total),
  };
}

export function parseStatsWindow(fromRaw: string | null, toRaw: string | null): StatsWindow | null {
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;
  if ((fromRaw && (!from || Number.isNaN(from.getTime()))) || (toRaw && (!to || Number.isNaN(to.getTime())))) {
    return null;
  }
  // to 按「日」语义补到当天末尾，避免漏掉当天的消息。
  const toInclusive = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : null;
  return { from, toInclusive, fromRaw, toRaw };
}

export function createYachFeedbackRoutes(store: ProductStore) {
  const app = new Hono();

  app.get('/yach-feedback/stats', async (context) => {
    const window = parseStatsWindow(
      context.req.query('from') ?? null,
      context.req.query('to') ?? null,
    );
    if (!window) {
      return context.json({ detail: 'from/to 需为合法日期（如 2026-11-01）' }, 422);
    }
    const conversations = await store.listConversationRecords();
    return context.json(aggregateYachFeedback(conversations, window));
  });

  return app;
}
