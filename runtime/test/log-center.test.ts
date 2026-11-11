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
  type LogTargetCandidate,
} from '../src/capabilities/log-center.js';
import { loadRuntimeConfig } from '../src/config.js';
import { progressLabelForTool } from '../src/channels/yach/progress-map.js';

const catalogPath = resolve(process.cwd(), 'contracts/log-catalog/catalog.yaml');
const identity = {
  learner_id: 'student-fixture-001',
  phone: '+8613800000000',
};

function syntheticCatalog(observationPlatform = ['device.platform']): LogCatalog {
  return {
    version: 1,
    vendor: 'aliyun',
    defaults: {
      region: 'cn-fixture',
      account: 'fixture-account',
      collection: 'fixture-collection',
      time: '1h',
    },
    stores: [{
      id: 'prod-fixture-client',
      topic: 'fixture-client-topic',
      env: 'prod',
      aliases: ['客户端测试'],
      description: '合成测试目标',
      notes: [],
      appids: [{
        id: 'app-fixture',
        aliases: [],
        description: '',
        key_fields: ['uid', 'device.platform'],
        identity_fields: { learner_id: ['uid'], phone: [], trace_id: [], request_id: [] },
        observation_fields: {
          platform: observationPlatform,
          platform_values: {},
          version: ['app.versionName'],
          device: ['device.id'],
          session: ['session.id'],
        },
        businesses: [{
          name: '测试业务',
          aliases: ['测试页面'],
          match: {},
        }],
      }],
    }],
  };
}

function testConfig() {
  return loadRuntimeConfig({
    HARMONY_AGENT_LOGCENTER_APP_ID: 'test-app',
    HARMONY_AGENT_LOGCENTER_APP_SECRET: 'test-secret',
    HARMONY_AGENT_LOGCENTER_BASE_URL: 'https://logcenter.example.test/api',
  });
}

function coordinates(candidate: LogTargetCandidate) {
  return {
    vendor: candidate.vendor,
    region: candidate.region,
    account: candidate.account,
    collection: candidate.collection,
    topic: candidate.topic,
    appid: candidate.appid,
  };
}

const correlatedLog = {
  uid: identity.learner_id,
  contact: identity.phone,
  appid: 'app-fixture',
  device: { id: 'device-fixture-001', platform: 'Android' },
  session: { id: 'session-fixture-001' },
  app: { versionName: '7.105.0' },
  message: `request failed for ${identity.learner_id}; phone=${identity.phone}`,
  authorization: 'Bearer fixture-secret-token',
  '@timestamp': '2026-11-11T08:00:00Z',
};

async function resolvedTools(
  requests: Array<{ url: URL; headers: Record<string, string> }>,
  logs: unknown[] = [correlatedLog],
  sourceText = `学员编号: ${identity.learner_id}; 联系电话: ${identity.phone}; 测试业务打不开`,
) {
  const tools = await createLogCatalogTools(testConfig(), {
    catalog: syntheticCatalog(),
    correlation: { identifiers: identity, sourceText },
    http: async ({ url, headers }) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, headers });
      if (parsed.pathname.endsWith('/count')) {
        return { status: 200, body: { code: 0, data: { total: logs.length, elapsed_millisecond: 9 } } };
      }
      return {
        status: 200,
        body: {
          code: 0,
          data: { total: logs.length, elapsed_millisecond: 11, progress: 'Complete', logs },
        },
      };
    },
  });
  assert.ok(tools);
  const resolved = await tools.resolve_log_target.execute!({ query: '测试业务' }, {} as never) as {
    status: string;
    candidates: LogTargetCandidate[];
    target_binding: { status: string };
  };
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.target_binding.status, 'confirmed');
  return { tools, candidate: resolved.candidates[0]! };
}

test('loads catalog and resolves 口语岛 to cloudlearn eagle-0008', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  for (const query of ['口语岛', '查一下口语岛最近日志'] as const) {
    const result = resolveLogTarget(catalog, query);
    assert.equal(result.status, 'resolved', query);
    assert.equal(result.candidates.length, 1, query);
    const hit = result.candidates[0]!;
    assert.equal(hit.store_id, 'prod-cloudlearn');
    assert.equal(hit.topic, 'prod-cloudlearn');
    assert.equal(hit.appid, 'log-eagle-0008-prod');
    assert.match(hit.suggested_query, /appid: "log-eagle-0008-prod"/);
  }
});

test('resolve returns not_found and ambiguous correctly', async () => {
  const catalog = await loadLogCatalog(catalogPath);
  assert.equal(resolveLogTarget(catalog, '完全不存在的业务词xyz').status, 'not_found');

  const ambiguousCatalog = syntheticCatalog();
  const second = structuredClone(ambiguousCatalog.stores[0]!);
  second.id = 'prod-fixture-other';
  second.topic = 'fixture-other-topic';
  second.appids[0]!.id = 'app-other';
  ambiguousCatalog.stores.push(second);
  const ambiguous = resolveLogTarget(ambiguousCatalog, '测试业务');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);
});

test('parseTimeRangeSeconds supports m/h', () => {
  const now = Date.UTC(2026, 10, 6, 8, 0, 0);
  assert.equal(parseTimeRangeSeconds('1h', now).end - parseTimeRangeSeconds('1h', now).start, 3600);
  assert.equal(parseTimeRangeSeconds('15m', now).end - parseTimeRangeSeconds('15m', now).start, 15 * 60);
});

test('does not mount tools without credentials', async () => {
  const config = loadRuntimeConfig({
    HARMONY_AGENT_LOGCENTER_APP_ID: '',
    HARMONY_AGENT_LOGCENTER_APP_SECRET: '',
  });
  assert.equal(isLogCenterConfigured(config), false);
  assert.equal(await createLogCatalogTools(config), null);
});

test('count/search share query, require user-selected binding, and sanitize observations', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const { tools, candidate } = await resolvedTools(requests);
  const input = { ...coordinates(candidate), time: '15m', query: candidate.suggested_query };

  const counted = await tools.count_cloud_logs.execute!(input, {} as never);
  assert.deepEqual(counted, { total: 1, elapsed_ms: 9 });
  const searched = await tools.search_cloud_logs.execute!({
    ...input,
    size: 5,
    from: 0,
  }, {} as never) as {
    observation_status: string;
    entries: Array<{
      matched_identifiers: Array<{ kind: string }>;
      observation_context: {
        observed_platform: string;
        observed_version: string;
        service_binding: { status: string; method: string };
        device_ref: string;
      };
    }>;
  };
  assert.equal(searched.observation_status, 'correlated');
  assert.equal(searched.entries.length, 1);
  const entry = searched.entries[0]!;
  assert.deepEqual(entry.matched_identifiers.map((item) => item.kind).sort(), ['learner_id', 'phone']);
  assert.equal(entry.observation_context.observed_platform, 'android');
  assert.equal(entry.observation_context.observed_version, '7.105.0');
  assert.equal(entry.observation_context.service_binding.status, 'confirmed');
  assert.equal(entry.observation_context.service_binding.method, 'user_selected');
  assert.notEqual(entry.observation_context.device_ref, 'device-fixture-001');
  const serialized = JSON.stringify(searched);
  assert.equal(serialized.includes(identity.learner_id), false);
  assert.equal(serialized.includes(identity.phone), false);
  assert.equal(serialized.includes('13800000000'), false);
  assert.equal(serialized.includes('fixture-secret-token'), false);

  assert.equal(requests.length, 2);
  const countQuery = requests[0]!.url.searchParams.get('query');
  const searchQuery = requests[1]!.url.searchParams.get('query');
  assert.ok(countQuery);
  assert.equal(countQuery, searchQuery);
  assert.match(countQuery!, /appid/);
  assert.equal(requests[0]!.url.searchParams.get('start') !== null, true);
  assert.equal(requests[0]!.url.searchParams.get('end') !== null, true);
  assert.equal(requests[0]!.headers['X-Sign-Appid'], 'test-app');
  assert.ok(requests[0]!.headers['X-Sign-Sign']);
});

test('unbound or paraphrased targets fail closed before any upstream request', async () => {
  let requestCount = 0;
  const tools = await createLogCatalogTools(testConfig(), {
    catalog: syntheticCatalog(),
    correlation: { identifiers: identity, sourceText: '用户只说测试业务，没有说改写后的词' },
    http: async () => {
      requestCount += 1;
      return { status: 200, body: { code: 0, data: { total: 0, logs: [] } } };
    },
  });
  assert.ok(tools);
  const resolved = await tools.resolve_log_target.execute!({ query: '测试页面' }, {} as never) as {
    target_binding: { status: string };
    candidates: LogTargetCandidate[];
  };
  assert.equal(resolved.target_binding.status, 'unconfirmed');
  await assert.rejects(
    tools.count_cloud_logs.execute!({
      ...coordinates(resolved.candidates[0]!), time: '15m', query: '*',
    }, {} as never),
    /log_target_unbound/,
  );
  await assert.rejects(
    tools.search_cloud_logs.execute!({
      vendor: 'aliyun', region: 'invented', account: 'invented', collection: 'invented',
      topic: 'invented', appid: 'invented', time: '15m', size: 5, from: 0,
    }, {} as never),
    /log_target_unbound/,
  );
  assert.equal(requestCount, 0);
});

test('discovery injects identity privately and returns observed platform and pseudonymous sessions', async () => {
  const requests: Array<{ url: URL }> = [];
  const tools = await createLogCatalogTools(testConfig(), {
    catalog: syntheticCatalog(),
    correlation: { identifiers: identity, sourceText: '测试业务打不开' },
    http: async ({ url }) => {
      const parsed = new URL(url);
      requests.push({ url: parsed });
      if (parsed.pathname.endsWith('/count')) {
        return { status: 200, body: { code: 0, data: { total: 1 } } };
      }
      return { status: 200, body: { code: 0, data: { total: 1, logs: [correlatedLog] } } };
    },
  });
  assert.ok(tools);
  const discovered = await tools.discover_client_sessions.execute!({ time: '1h', size: 5 }, {} as never) as {
    status: string;
    observed_platform: string;
    candidates: Array<{ entries: unknown[]; observed_versions: string[]; device_refs: string[] }>;
  };
  assert.equal(discovered.status, 'resolved');
  assert.equal(discovered.observed_platform, 'android');
  assert.equal(discovered.candidates[0]?.entries.length, 1);
  assert.deepEqual(discovered.candidates[0]?.observed_versions, ['7.105.0']);
  assert.equal(discovered.candidates[0]?.device_refs.length, 1);
  const serialized = JSON.stringify(discovered);
  assert.equal(serialized.includes(identity.learner_id), false);
  assert.equal(serialized.includes('13800000000'), false);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.url.searchParams.get('query') ?? '', /student-fixture-001/);
  assert.equal(requests[0]!.url.searchParams.get('query'), requests[1]!.url.searchParams.get('query'));
  assert.equal(requests[0]!.url.searchParams.get('start'), requests[1]!.url.searchParams.get('start'));
  assert.equal(requests[0]!.url.searchParams.get('end'), requests[1]!.url.searchParams.get('end'));
});

test('unmatched, empty, and conflicting observations cannot confirm a platform', async () => {
  const unmatched = {
    ...correlatedLog,
    uid: 'another-fixture-student',
    contact: 'not-a-phone',
    message: 'unrelated fixture log',
  };
  const emptyRequests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const empty = await resolvedTools(emptyRequests, []);
  const emptyResult = await empty.tools.search_cloud_logs.execute!({
    ...coordinates(empty.candidate), time: '1h', size: 5, from: 0,
  }, {} as never) as { observation_status: string; limitations: string[] };
  assert.equal(emptyResult.observation_status, 'empty');
  assert.match(emptyResult.limitations[0]!, /不能确认平台/);

  const unmatchedRequests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const unmatchedBound = await resolvedTools(unmatchedRequests, [unmatched]);
  const unmatchedResult = await unmatchedBound.tools.search_cloud_logs.execute!({
    ...coordinates(unmatchedBound.candidate), time: '1h', size: 5, from: 0,
  }, {} as never) as {
    observation_status: string;
    entries: Array<{ observation_context: { observed_platform: string } }>;
  };
  assert.equal(unmatchedResult.observation_status, 'uncorrelated');
  assert.equal(unmatchedResult.entries[0]?.observation_context.observed_platform, 'unknown');

  const conflictingRequests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const conflicting = await resolvedTools(conflictingRequests, [
    correlatedLog,
    { ...correlatedLog, device: { ...correlatedLog.device, platform: 'iOS' } },
  ]);
  const conflictResult = await conflicting.tools.search_cloud_logs.execute!({
    ...coordinates(conflicting.candidate), time: '1h', size: 5, from: 0,
  }, {} as never) as { entries: Array<{ observation_context: { observed_platform: string } }> };
  const aggregate = await (async () => {
    const requests: Array<{ url: URL }> = [];
    const tools = await createLogCatalogTools(testConfig(), {
      catalog: syntheticCatalog(),
      correlation: { identifiers: identity, sourceText: '测试业务' },
      http: async ({ url }) => {
        requests.push({ url: new URL(url) });
        if (url.includes('/count')) return { status: 200, body: { code: 0, data: { total: 2 } } };
        return { status: 200, body: { code: 0, data: { total: 2, logs: [
          correlatedLog,
          { ...correlatedLog, device: { ...correlatedLog.device, platform: 'iOS' } },
        ] } } };
      },
    });
    return tools!.discover_client_sessions.execute!({ time: '1h', size: 5 }, {} as never) as Promise<{
      observed_platform: string;
      platform_conflict: boolean;
    }>;
  })();
  assert.equal(conflictResult.entries.length, 2);
  assert.equal(aggregate.observed_platform, 'unknown');
  assert.equal(aggregate.platform_conflict, true);
});

test('upstream errors cannot echo raw learner identifiers', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const { tools, candidate } = await resolvedTools(requests);
  const failing = await createLogCatalogTools(testConfig(), {
    catalog: syntheticCatalog(),
    correlation: { identifiers: identity, sourceText: '测试业务' },
    http: async () => ({
      status: 200,
      body: { code: 400, msg: `bad query for ${identity.learner_id} ${identity.phone}` },
    }),
  });
  assert.ok(failing);
  const resolved = await failing.resolve_log_target.execute!({ query: '测试业务' }, {} as never) as {
    candidates: LogTargetCandidate[];
  };
  await assert.rejects(
    failing.search_cloud_logs.execute!({
      ...coordinates(resolved.candidates[0]!), time: '1h', size: 5, from: 0,
    }, {} as never),
    (error: unknown) => {
      const message = String(error);
      assert.equal(message.includes(identity.learner_id), false);
      assert.equal(message.includes(identity.phone), false);
      assert.equal(message.includes('13800000000'), false);
      return true;
    },
  );
  assert.ok(candidate);
});

test('progress map labels discovery as remote log investigation', () => {
  assert.equal(progressLabelForTool('resolve_log_target'), '正在查询远程日志');
  assert.equal(progressLabelForTool('search_cloud_logs'), '正在查询远程日志');
  assert.equal(progressLabelForTool('discover_client_sessions'), '正在查询远程日志');
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
    }), {
      catalog: syntheticCatalog(),
      correlation: { identifiers: identity, sourceText: '测试业务' },
      abortSignal: controller.signal,
    });
    assert.ok(tools);
    try {
      const resolved = await tools.resolve_log_target.execute!({ query: '测试业务' }, {} as never) as {
        candidates: LogTargetCandidate[];
      };
      const request = tools.count_cloud_logs.execute!({
        ...coordinates(resolved.candidates[0]!), time: '15m', query: '*',
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
