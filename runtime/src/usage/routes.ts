import { Hono } from 'hono';
import type { ProductStore } from '../product/store.js';
import { aggregateUsageStats, aggregateUsageStatsForDay } from './aggregate.js';
import { addCalendarDays, isValidDateYmd, todayYmd, yesterdayYmd } from './day.js';
import { pushUsageDigest, type DigestPushDeps } from './digest-push.js';

export type UsageRangePreset = 'today' | 'yesterday' | '3d' | '7d' | '30d';

export interface UsageRoutesDeps {
  store: ProductStore;
  timeZone: string;
  digest?: DigestPushDeps;
  runDigest?: (dateYmd: string) => Promise<unknown>;
}

/** Resolve preset range keys used by the web page (timezone-aware). */
export function resolveUsageRangePreset(
  key: UsageRangePreset,
  timeZone: string,
  now = new Date(),
): { from: string; to: string } {
  const today = todayYmd(timeZone, now);
  if (key === 'today') return { from: today, to: today };
  if (key === 'yesterday') {
    const y = yesterdayYmd(timeZone, now);
    return { from: y, to: y };
  }
  const days = key === '3d' ? 3 : key === '7d' ? 7 : 30;
  // 近 N 天：含今天，共 N 个自然日 → from = today-(N-1)
  const from = addCalendarDays(today, -(days - 1));
  return { from, to: today };
}

function isUsageRangePreset(value: string): value is UsageRangePreset {
  return value === 'today'
    || value === 'yesterday'
    || value === '3d'
    || value === '7d'
    || value === '30d';
}

export function createUsageRoutes(deps: UsageRoutesDeps) {
  const app = new Hono();

  app.get('/stats', async (context) => {
    const rangeRaw = context.req.query('range')?.trim() || null;
    const fromRaw = context.req.query('from')?.trim() || null;
    const toRaw = context.req.query('to')?.trim() || null;
    const dateRaw = context.req.query('date')?.trim() || null;

    let fromYmd: string;
    let toYmd: string;
    if (rangeRaw) {
      if (!isUsageRangePreset(rangeRaw)) {
        return context.json({ detail: 'range 需为 today|yesterday|3d|7d|30d' }, 422);
      }
      ({ from: fromYmd, to: toYmd } = resolveUsageRangePreset(rangeRaw, deps.timeZone));
    } else if (fromRaw || toRaw) {
      fromYmd = fromRaw || toRaw!;
      toYmd = toRaw || fromRaw!;
      if (!isValidDateYmd(fromYmd) || !isValidDateYmd(toYmd)) {
        return context.json({ detail: 'from/to 需为合法日期（如 2026-11-26）' }, 422);
      }
    } else if (dateRaw) {
      if (!isValidDateYmd(dateRaw)) {
        return context.json({ detail: 'date 需为合法日期（如 2026-11-26）' }, 422);
      }
      fromYmd = dateRaw;
      toYmd = dateRaw;
    } else {
      fromYmd = yesterdayYmd(deps.timeZone);
      toYmd = fromYmd;
    }

    const conversations = await deps.store.listConversationRecords();
    const stats = aggregateUsageStats(conversations, fromYmd, toYmd, deps.timeZone);
    return context.json({
      ...stats,
      range: rangeRaw && isUsageRangePreset(rangeRaw) ? rangeRaw : null,
    });
  });

  app.post('/digest/run', async (context) => {
    const body = await context.req.json().catch(() => ({})) as { date?: string };
    const dateYmd = body.date?.trim() || yesterdayYmd(deps.timeZone);
    if (!isValidDateYmd(dateYmd)) {
      return context.json({ detail: 'date 需为合法日期（如 2026-11-26）' }, 422);
    }
    if (deps.runDigest) {
      const result = await deps.runDigest(dateYmd);
      return context.json(result);
    }
    if (!deps.digest) {
      return context.json({ detail: 'digest push not configured' }, 503);
    }
    const conversations = await deps.store.listConversationRecords();
    const stats = aggregateUsageStatsForDay(conversations, dateYmd, deps.timeZone);
    const pushed = await pushUsageDigest(stats, deps.digest);
    return context.json({ stats, push: pushed });
  });

  return app;
}
