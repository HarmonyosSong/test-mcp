import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createLogCatalogTools,
  isLogCenterConfigured,
  loadLogCatalog,
  parseTimeRangeSeconds,
  resolveLogTarget,
  type LogCatalog,
} from '../src/capabilities/log-center.js';
import { loadRuntimeConfig } from '../src/config.js';
import { progressLabelForTool } from '../src/channels/yach/progress-map.js';

const catalogPath = resolve(process.cwd(), 'contracts/log-catalog/catalog.yaml');

test('loads catalog and resolves 口语岛 to cloudlearn eagle-0008', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  for (const query of ['口语岛', '查一下口语岛最近日志'] as const) {
    const result = resolveLogTarget(catalog, query);
    assert.equal(result.status, 'resolved', query);
    assert.equal(result.candidates.length, 1, query);
    const hit = result.candidates[0]!;
    assert.equal(hit.source, 'aliyun_sls');
    assert.equal(hit.log_kind, 'product_event');
    assert.equal(hit.target_id, 'log-eagle-0008-prod');
    assert.equal(hit.store_id, 'prod-cloudlearn');
    assert.equal(hit.topic, 'prod-cloudlearn');
    assert.equal(hit.appid, 'log-eagle-0008-prod');
    assert.equal(hit.account, '1743276692096170');
    assert.equal(hit.collection, 'pysy-front-log');
    assert.match(hit.suggested_query, /appid: "log-eagle-0008-prod"/);
  }
});

test('resolves 鸿蒙 to har appid on shared prod-ios store', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  const result = resolveLogTarget(catalog, '鸿蒙');
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidates[0]?.platform, 'harmony');
  assert.equal(result.candidates[0]?.appid, 'log-har-001-prod');
  assert.equal(result.candidates[0]?.store_id, 'prod-ios');
  assert.equal(result.candidates[0]?.topic, 'prod-ios');
  assert.match(result.candidates[0]!.suggested_query, /appid: "log-har-001-prod"/);
});

test('resolves 装扮商城 by appid not store name', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  const result = resolveLogTarget(catalog, '装扮商城');
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidates[0]?.appid, 'log-fe-virtually-mall-prod');
  assert.equal(result.candidates[0]?.store_id, 'prod-ios');
});

test('resolves APM aliases to logcenter service_id targets', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  const pad = resolveLogTarget(catalog, '培优Pad安卓监控');
  assert.equal(pad.status, 'resolved');
  assert.equal(pad.candidates[0]?.source, 'logcenter');
  assert.equal(pad.candidates[0]?.log_kind, 'client_apm');
  assert.equal(pad.candidates[0]?.service_id, 1116);
  assert.equal(pad.candidates[0]?.app_clientid, 'XesPadPyAndroid');
  assert.equal(pad.candidates[0]?.client_form, 'pad');

  const phone = resolveLogTarget(catalog, 'XesPyAndroid');
  assert.equal(phone.status, 'resolved');
  assert.equal(phone.candidates[0]?.service_id, 846);

  const iphone = resolveLogTarget(catalog, '培优iPhone监控');
  assert.equal(iphone.status, 'resolved');
  assert.equal(iphone.candidates[0]?.service_id, 847);

  const ipad = resolveLogTarget(catalog, 'XesPyIOSHD');
  assert.equal(ipad.status, 'resolved');
  assert.equal(ipad.candidates[0]?.service_id, 1028);
});

test('vague 安卓 is ambiguous across product_event and APM', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  const result = resolveLogTarget(catalog, '安卓');
  assert.equal(result.status, 'ambiguous');
  const sources = new Set(result.candidates.map((c) => c.source));
  assert.ok(sources.has('logcenter'));
});

test('resolve returns not_found and ambiguous correctly', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  assert.equal(resolveLogTarget(catalog, '完全不存在的业务词xyz').status, 'not_found');

  const ambiguousCatalog: LogCatalog = {
    version: 3,
    vendor: 'aliyun',
    defaults: catalog.defaults,
    stores: [
      { id: 's', topic: 's', env: 'prod', description: '', notes: [] },
    ],
    targets: [
      {
        id: 'app-a',
        source: 'aliyun_sls',
        log_kind: 'product_event',
        store_ref: 's',
        aliases: ['同名'],
        description: '',
        notes: [],
        key_fields: [],
        businesses: [],
        suggested_query: '',
        monitor_types: {},
      },
      {
        id: 'app-b',
        source: 'aliyun_sls',
        log_kind: 'product_event',
        store_ref: 's',
        aliases: ['同名'],
        description: '',
        notes: [],
        key_fields: [],
        businesses: [],
        suggested_query: '',
        monitor_types: {},
      },
    ],
  };
  const ambiguous = resolveLogTarget(ambiguousCatalog, '同名问题');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);
});

test('parseTimeRangeSeconds supports m/h', () => {
  const now = Date.UTC(2026, 10, 6, 8, 0, 0);
  const hour = parseTimeRangeSeconds('1h', now);
  assert.equal(hour.end - hour.start, 3600);
  const mins = parseTimeRangeSeconds('15m', now);
  assert.equal(mins.end - mins.start, 15 * 60);
});

test('does not mount tools without credentials', async () => {
  const config = loadRuntimeConfig({
    HARMONY_AGENT_LOGCENTER_APP_ID: '',
    HARMONY_AGENT_LOGCENTER_APP_SECRET: '',
  });
  assert.equal(isLogCenterConfigured(config), false);
  assert.equal(await createLogCatalogTools(config), null);
});

test('createLogCatalogTools signs and searches with mocked HTTP', async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const config = loadRuntimeConfig({
    HARMONY_AGENT_LOGCENTER_APP_ID: 'app-id',
    HARMONY_AGENT_LOGCENTER_APP_SECRET: 'app-secret',
    HARMONY_AGENT_LOGCENTER_BASE_URL: 'https://logcenter.example.test/api',
    HARMONY_AGENT_LOG_CATALOG: catalogPath,
  });
  assert.equal(isLogCenterConfigured(config), true);

  const tools = await createLogCatalogTools(config, {
    http: async ({ url, headers }) => {
      requests.push({ url, headers });
      if (url.includes('/cloud/') && url.includes('/count')) {
        return { status: 200, body: { code: 0, data: { total: 12, elapsed_millisecond: 9 } } };
      }
      if (url.includes('/cloud/') && url.includes('/search')) {
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              total: 1,
              elapsed_millisecond: 11,
              progress: 'Complete',
              logs: [{ appid: 'log-eagle-0008-prod', pageid: '新口语岛', desc: 'ok' }],
            },
          },
        };
      }
      if (url.includes('skill/search/time')) {
        return { status: 200, body: { code: 0, total: 42, data: { data: [] } } };
      }
      if (url.includes('skill/search')) {
        return {
          status: 200,
          body: {
            code: 0,
            total: 1,
            data: { data: [{ 'c.monitorLogType': '1', topic: 'basiclog-monitor_26_1002935' }] },
          },
        };
      }
      return { status: 200, body: { code: 0, data: {} } };
    },
  });
  assert.ok(tools);

  const resolved = await tools.resolve_log_target.execute!({ query: '查一下口语岛最近日志' }, {} as never);
  assert.equal((resolved as { status: string }).status, 'resolved');

  const counted = await tools.count_cloud_logs.execute!({
    vendor: 'aliyun',
    region: 'cn-beijing',
    account: '1743276692096170',
    collection: 'pysy-front-log',
    topic: 'prod-cloudlearn',
    time: '15m',
  }, {} as never);
  assert.deepEqual(counted, { total: 12, elapsed_ms: 9 });

  const searched = await tools.search_cloud_logs.execute!({
    vendor: 'aliyun',
    region: 'cn-beijing',
    account: '1743276692096170',
    collection: 'pysy-front-log',
    topic: 'prod-cloudlearn',
    time: '15m',
    query: 'appid: "log-eagle-0008-prod"',
    size: 20,
    from: 0,
  }, {} as never) as { total: number; logs: unknown[] };
  assert.equal(searched.total, 1);
  assert.equal(searched.logs.length, 1);

  const serviceCounted = await tools.count_logs.execute!({
    service_id: 846,
    time: '15m',
    query: 'c.monitorLogType:1',
  }, {} as never);
  assert.deepEqual(serviceCounted, { total: 42 });

  const serviceQueried = await tools.query_logs.execute!({
    service_id: 846,
    time: '15m',
    query: 'c.monitorLogType:1',
    page: 1,
    size: 40,
  }, {} as never) as { total: number; logs: unknown[]; page: number };
  assert.equal(serviceQueried.total, 1);
  assert.equal(serviceQueried.page, 1);
  assert.equal(serviceQueried.logs.length, 1);

  assert.equal(requests.length, 4);
  assert.match(requests[0]!.url, /skill\/cloud\/aliyun\/count/);
  assert.match(requests[1]!.url, /skill\/cloud\/aliyun\/search/);
  assert.match(requests[2]!.url, /skill\/search\/time/);
  assert.match(requests[3]!.url, /skill\/search/);
  assert.equal(requests[0]!.headers['X-Sign-Appid'], 'app-id');
});

test('progress map labels log tools separately from knowledge', () => {
  assert.equal(progressLabelForTool('resolve_log_target'), '正在查询远程日志');
  assert.equal(progressLabelForTool('search_cloud_logs'), '正在查询远程日志');
  assert.equal(progressLabelForTool('count_logs'), '正在查询远程日志');
  assert.equal(progressLabelForTool('query_logs'), '正在查询远程日志');
  assert.equal(progressLabelForTool('search_knowledge'), '正在查阅知识库');
});

for (const mode of ['cancel', 'timeout'] as const) {
  test(`log requests stop on round ${mode}`, { timeout: 5_000 }, async () => {
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const server = createServer(() => markRequested());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const controller = new AbortController();
    const tools = await createLogCatalogTools(loadRuntimeConfig({
      HARMONY_AGENT_LOGCENTER_APP_ID: 'test-app',
      HARMONY_AGENT_LOGCENTER_APP_SECRET: 'test-secret',
      HARMONY_AGENT_LOGCENTER_BASE_URL: `http://127.0.0.1:${address.port}/api`,
      HARMONY_AGENT_LOGCENTER_TIMEOUT_MS: mode === 'timeout' ? '100' : '3000',
      HARMONY_AGENT_LOG_CATALOG: catalogPath,
    }), { abortSignal: controller.signal });
    assert.ok(tools);
    try {
      const request = tools.count_cloud_logs.execute!({
        vendor: 'aliyun', region: 'cn-beijing', account: 'test-account',
        collection: 'test-collection', topic: 'test-topic', time: '15m',
      }, {} as never);
      const rejected = assert.rejects(request, { name: mode === 'timeout' ? 'TimeoutError' : 'AbortError' });
      await requested;
      if (mode === 'cancel') controller.abort();
      await rejected;
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
