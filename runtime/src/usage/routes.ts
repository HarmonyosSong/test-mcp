import { Hono } from 'hono';
import type { ProductStore } from '../product/store.js';
import { aggregateUsageStats } from './aggregate.js';
import { isValidDateYmd, yesterdayYmd } from './day.js';
import { pushUsageDigest, type DigestPushDeps } from './digest-push.js';

export interface UsageRoutesDeps {
  store: ProductStore;
  timeZone: string;
  digest?: DigestPushDeps;
  runDigest?: (dateYmd: string) => Promise<unknown>;
}

export function createUsageRoutes(deps: UsageRoutesDeps) {
  const app = new Hono();

  app.get('/stats', async (context) => {
    const raw = context.req.query('date')?.trim() || yesterdayYmd(deps.timeZone);
    if (!isValidDateYmd(raw)) {
      return context.json({ detail: 'date 需为合法日期（如 2026-11-26）' }, 422);
    }
    const conversations = await deps.store.listConversationRecords();
    return context.json(aggregateUsageStats(conversations, raw, deps.timeZone));
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
    const stats = aggregateUsageStats(conversations, dateYmd, deps.timeZone);
    const pushed = await pushUsageDigest(stats, deps.digest);
    return context.json({ stats, push: pushed });
  });

  return app;
}
