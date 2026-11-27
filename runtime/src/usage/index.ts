import type { RuntimeConfig } from '../config.js';
import type { ProductStore } from '../product/store.js';
import { integrationInfo, integrationWarn } from '../observability/integration-log.js';
import { aggregateUsageStats } from './aggregate.js';
import { USAGE_API_MOUNT, USAGE_PAGE_PATH } from './constants.js';
import { pushUsageDigest } from './digest-push.js';
import { createUsageRoutes } from './routes.js';
import { parseDailyCron, startDigestScheduler, type DigestSchedulerHandle } from './scheduler.js';

export { USAGE_API_MOUNT, USAGE_PAGE_PATH };
export { aggregateUsageStats } from './aggregate.js';
export type { UsageStatsResult, UsageStatsItem, UsageStatsSummary } from './types.js';

export type UsageModule = {
  routes: ReturnType<typeof createUsageRoutes>;
  start: () => void;
  close: () => void;
  runDigest: (dateYmd: string) => Promise<unknown>;
};

export function createUsageModule(options: {
  store: ProductStore;
  config: RuntimeConfig;
}): UsageModule {
  const { store, config } = options;
  const timeZone = config.usageDigestTz || 'Asia/Shanghai';
  const digestDeps = {
    config: {
      publicBaseUrl: config.publicBaseUrl,
      appPrefix: config.appPrefix,
      yachCliPath: config.yachCliPath,
      yachAppKey: config.yachAppKey,
      yachAppSecret: config.yachAppSecret,
      usageDigestGroupId: config.usageDigestGroupId,
    },
  };

  const runDigest = async (dateYmd: string) => {
    const conversations = await store.listConversationRecords();
    const stats = aggregateUsageStats(conversations, dateYmd, timeZone);
    const push = await pushUsageDigest(stats, digestDeps);
    return { stats, push };
  };

  const routes = createUsageRoutes({
    store,
    timeZone,
    digest: digestDeps,
    runDigest,
  });

  let scheduler: DigestSchedulerHandle | null = null;

  return {
    routes,
    runDigest,
    start: () => {
      const groupId = config.usageDigestGroupId.trim();
      if (!groupId) {
        integrationInfo('usage', 'digest scheduler off (empty GROUP_ID)');
        return;
      }
      if (!config.yachEnabled) {
        integrationWarn('usage', 'digest scheduler off (YACH disabled)');
        return;
      }
      if (!parseDailyCron(config.usageDigestCron)) {
        integrationWarn('usage', 'digest cron invalid; expected "m h * * *"', {
          cron: config.usageDigestCron,
        });
        return;
      }
      scheduler = startDigestScheduler({
        cron: config.usageDigestCron,
        timeZone,
        onFire: async (ymd) => {
          try {
            await runDigest(ymd);
          } catch (error) {
            integrationWarn('usage', 'scheduled digest failed', {
              date: ymd,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      integrationInfo('usage', 'digest scheduler started', {
        cron: config.usageDigestCron,
        timeZone,
        groupId,
        page: `${config.appPrefix}${USAGE_PAGE_PATH}`,
      });
    },
    close: () => {
      scheduler?.close();
      scheduler = null;
    },
  };
}
