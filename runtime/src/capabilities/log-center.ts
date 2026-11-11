import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createTool } from '@mastra/core/tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
import { integrationError, integrationInfo, integrationWarn } from '../observability/integration-log.js';

export const LOGCENTER_DEFAULT_BASE_URL = 'https://logcenter-api.tal.com/api';
export const LOG_CATALOG_DEFAULT_RELATIVE = 'runtime/contracts/log-catalog/catalog.yaml';

const MatchSchema = z.record(z.string(), z.string()).default({});

const BusinessSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  match: MatchSchema,
}).strict();

const SourceSchema = z.enum(['aliyun_sls', 'logcenter']);
const LogKindSchema = z.enum(['product_event', 'client_apm']);
const PlatformSchema = z.enum(['android', 'ios', 'harmony', 'h5']).optional();
const ClientFormSchema = z.enum(['phone', 'pad', 'h5', 'harmony']).optional();

/** Physical SLS Logstore coords only — no business aliases. */
const StoreSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  env: z.enum(['prod', 'test']).default('prod'),
  description: z.string().default(''),
  notes: z.array(z.string()).default([]),
  region: z.string().optional(),
  account: z.string().optional(),
  collection: z.string().optional(),
  vendor: z.string().optional(),
}).strict();

/** First-class resolve unit: SLS appid or logcenter APM service. */
const TargetSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  log_kind: LogKindSchema,
  platform: PlatformSchema,
  client_form: ClientFormSchema,
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().default(''),
  notes: z.array(z.string()).default([]),
  key_fields: z.array(z.string().min(1)).default([]),
  businesses: z.array(BusinessSchema).default([]),
  suggested_query: z.string().default(''),
  monitor_types: z.record(z.string(), z.string()).default({}),
  // aliyun_sls
  store_ref: z.string().min(1).optional(),
  // logcenter
  service_id: z.number().int().positive().optional(),
  app_clientid: z.string().min(1).optional(),
  topic: z.string().optional(),
  env: z.enum(['prod', 'test']).optional(),
}).strict().superRefine((target, ctx) => {
  if (target.source === 'aliyun_sls' && !target.store_ref) {
    ctx.addIssue({ code: 'custom', message: `aliyun_sls target ${target.id} requires store_ref`, path: ['store_ref'] });
  }
  if (target.source === 'logcenter' && target.service_id == null) {
    ctx.addIssue({ code: 'custom', message: `logcenter target ${target.id} requires service_id`, path: ['service_id'] });
  }
});

export const LogCatalogSchema = z.object({
  version: z.number().int().positive(),
  vendor: z.string().min(1).default('aliyun'),
  defaults: z.object({
    region: z.string().min(1),
    account: z.string().min(1),
    collection: z.string().min(1),
    time: z.string().min(1).default('1h'),
  }).strict(),
  stores: z.array(StoreSchema).default([]),
  targets: z.array(TargetSchema).min(1),
}).strict().superRefine((catalog, ctx) => {
  const storeIds = new Set(catalog.stores.map((s) => s.id));
  for (const [index, target] of catalog.targets.entries()) {
    if (target.source === 'aliyun_sls' && target.store_ref && !storeIds.has(target.store_ref)) {
      ctx.addIssue({
        code: 'custom',
        message: `target ${target.id} store_ref "${target.store_ref}" not found in stores`,
        path: ['targets', index, 'store_ref'],
      });
    }
  }
});

export type LogCatalog = z.infer<typeof LogCatalogSchema>;
export type LogStore = z.infer<typeof StoreSchema>;
export type LogTarget = z.infer<typeof TargetSchema>;
export type LogSource = z.infer<typeof SourceSchema>;
export type LogKind = z.infer<typeof LogKindSchema>;

export type LogTargetCandidate = {
  source: LogSource;
  log_kind: LogKind;
  platform: string | null;
  client_form: string | null;
  target_id: string;
  store_id: string | null;
  topic: string;
  vendor: string | null;
  region: string | null;
  account: string | null;
  collection: string | null;
  appid: string | null;
  business: string | null;
  service_id: number | null;
  app_clientid: string | null;
  suggested_query: string;
  key_fields: string[];
  monitor_types: Record<string, string>;
  notes: string[];
};

export type ResolveLogTargetResult = {
  status: 'resolved' | 'ambiguous' | 'not_found';
  candidates: LogTargetCandidate[];
};

type AliasHit = {
  target: LogTarget;
  business: z.infer<typeof BusinessSchema> | null;
  score: number;
};

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase();
}

/** Higher is better: exact alias > query contains alias > alias contains query. */
function aliasScore(query: string, alias: string, base: number): number {
  const q = normalize(query);
  const a = normalize(alias);
  if (!q || !a) return 0;
  if (q === a) return base + 20;
  if (q.includes(a)) return base + 10;
  if (a.includes(q) && q.length >= 2) return base + 1;
  return 0;
}

function bestAliasScore(query: string, aliases: string[], base: number): number {
  return Math.max(0, ...aliases.map((alias) => aliasScore(query, alias, base)));
}

function buildSlsSuggestedQuery(appid: string, match: Record<string, string>): string {
  const parts = [`appid: "${appid}"`];
  for (const [key, value] of Object.entries(match)) {
    if (!value) continue;
    parts.push(`${key}: "${value}"`);
  }
  return parts.join(' and ');
}

function resolveStore(catalog: LogCatalog, storeRef: string | undefined): LogStore | null {
  if (!storeRef) return null;
  return catalog.stores.find((store) => store.id === storeRef) ?? null;
}

function toCandidate(catalog: LogCatalog, hit: AliasHit): LogTargetCandidate {
  const { target, business } = hit;
  const match = business?.match ?? {};
  if (target.source === 'logcenter') {
    return {
      source: target.source,
      log_kind: target.log_kind,
      platform: target.platform ?? null,
      client_form: target.client_form ?? null,
      target_id: target.id,
      store_id: null,
      topic: target.topic ?? '',
      vendor: null,
      region: null,
      account: null,
      collection: null,
      appid: null,
      business: business?.name ?? null,
      service_id: target.service_id ?? null,
      app_clientid: target.app_clientid ?? null,
      suggested_query: target.suggested_query || '*',
      key_fields: target.key_fields,
      monitor_types: target.monitor_types,
      notes: target.notes,
    };
  }
  const store = resolveStore(catalog, target.store_ref);
  return {
    source: target.source,
    log_kind: target.log_kind,
    platform: target.platform ?? null,
    client_form: target.client_form ?? null,
    target_id: target.id,
    store_id: store?.id ?? target.store_ref ?? null,
    topic: store?.topic ?? '',
    vendor: store?.vendor ?? catalog.vendor,
    region: store?.region ?? catalog.defaults.region,
    account: store?.account ?? catalog.defaults.account,
    collection: store?.collection ?? catalog.defaults.collection,
    appid: target.id,
    business: business?.name ?? null,
    service_id: null,
    app_clientid: null,
    suggested_query: target.suggested_query || buildSlsSuggestedQuery(target.id, match),
    key_fields: target.key_fields,
    monitor_types: {},
    notes: [...target.notes, ...(store?.notes ?? [])],
  };
}

export function resolveLogTarget(catalog: LogCatalog, query: string): ResolveLogTargetResult {
  const hits: AliasHit[] = [];
  for (const target of catalog.targets) {
    for (const business of target.businesses) {
      const score = bestAliasScore(query, [business.name, ...business.aliases], 30);
      if (score > 0) hits.push({ target, business, score });
    }
    const identityAliases = [
      target.id,
      ...(target.app_clientid ? [target.app_clientid] : []),
      ...(target.service_id != null ? [String(target.service_id)] : []),
      ...target.aliases,
    ];
    const targetScore = bestAliasScore(query, identityAliases, 20);
    if (targetScore > 0) hits.push({ target, business: null, score: targetScore });
  }

  // Weak: physical store id/topic → all SLS targets sharing that store (usually ambiguous).
  for (const store of catalog.stores) {
    const storeScore = bestAliasScore(query, [store.id, store.topic], 5);
    if (storeScore <= 0) continue;
    for (const target of catalog.targets) {
      if (target.source === 'aliyun_sls' && target.store_ref === store.id) {
        hits.push({ target, business: null, score: storeScore });
      }
    }
  }

  const best = Math.max(0, ...hits.map((hit) => hit.score));
  const filtered = hits.filter((hit) => hit.score === best && best > 0);
  const dedup = new Map<string, AliasHit>();
  for (const hit of filtered) {
    const key = `${hit.target.source}\0${hit.target.id}\0${hit.business?.name ?? ''}`;
    if (!dedup.has(key)) dedup.set(key, hit);
  }
  const unique = [...dedup.values()];

  if (unique.length === 0) return { status: 'not_found', candidates: [] };
  if (unique.length === 1) return { status: 'resolved', candidates: [toCandidate(catalog, unique[0]!)] };
  return { status: 'ambiguous', candidates: unique.map((hit) => toCandidate(catalog, hit)) };
}

export function parseTimeRangeSeconds(time: string, nowMs = Date.now()): { start: number; end: number } {
  const raw = time.trim().toLowerCase();
  const end = Math.floor(nowMs / 1000);
  const match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days|w|week|weeks)$/);
  if (!match) throw new Error(`log_invalid_request: unsupported time range "${time}"`);
  const amount = Number(match[1]);
  const unit = match[2]!;
  const minutes = ['h', 'hour', 'hours'].includes(unit)
    ? amount * 60
    : ['d', 'day', 'days'].includes(unit)
      ? amount * 60 * 24
      : ['w', 'week', 'weeks'].includes(unit)
        ? amount * 60 * 24 * 7
        : amount;
  return { start: end - minutes * 60, end };
}

export function isLogCenterConfigured(config: Pick<RuntimeConfig, 'logcenterAppId' | 'logcenterAppSecret'>): boolean {
  return Boolean(config.logcenterAppId.trim() && config.logcenterAppSecret.trim());
}

export function logCatalogPath(config: Pick<RuntimeConfig, 'projectRoot' | 'logCatalogPath'>): string {
  return config.logCatalogPath || resolve(config.projectRoot, LOG_CATALOG_DEFAULT_RELATIVE);
}

export async function loadLogCatalog(path: string): Promise<LogCatalog> {
  const text = await readFile(path, 'utf8');
  return LogCatalogSchema.parse(parseYaml(text));
}

function signHeaders(appId: string, appSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, string> {
  const sign = createHash('md5').update(`${appId}&${nowSeconds}${appSecret}`).digest('hex');
  return {
    'X-Sign-Appid': appId,
    'X-Sign-TimeStamp': String(nowSeconds),
    'X-Sign-Sign': sign,
  };
}

function truncateValue(value: unknown, max = 500): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => truncateValue(item, max));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    return Object.fromEntries(entries.map(([key, item]) => [key, truncateValue(item, max)]));
  }
  return value;
}

function extractLogList(body: Record<string, unknown>): unknown[] {
  const data = body.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const nested = data as { data?: unknown; list?: unknown; logs?: unknown };
    if (Array.isArray(nested.data)) return nested.data;
    if (Array.isArray(nested.list)) return nested.list;
    if (Array.isArray(nested.logs)) return nested.logs;
  }
  if (Array.isArray(body.list)) return body.list as unknown[];
  if (Array.isArray(body.logs)) return body.logs as unknown[];
  return [];
}

export type LogCenterHttp = (input: {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;

const defaultHttp: LogCenterHttp = async (input) => {
  const response = await fetch(input.url, { method: input.method, headers: input.headers, signal: input.signal });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, body };
};

export class LogCenterClient {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly baseUrl: string,
    private readonly http: LogCenterHttp = defaultHttp,
    private readonly options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
  ) {}

  private endpoint(path: string, params: Record<string, string | number | boolean>): string {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async request(path: string, params: Record<string, string | number | boolean>): Promise<Record<string, unknown>> {
    this.options.abortSignal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const signal = this.options.abortSignal ? AbortSignal.any([this.options.abortSignal, deadline]) : deadline;
    const url = this.endpoint(path, params);
    integrationInfo('logcenter', 'request start', {
      path,
      baseUrl: this.baseUrl,
      region: params.region,
      collection: params.collection_id,
      topic: params.topic_id,
      serviceId: params.service_id,
      accountConfigured: Boolean(params.account_ak_id),
    });
    const { status, body } = await this.http({
      method: 'GET',
      url,
      headers: signHeaders(this.appId, this.appSecret),
      signal,
    });
    if (status === 403 || (typeof body === 'object' && body && (body as { code?: number }).code === 403)) {
      integrationWarn('logcenter', 'permission denied', { path, status });
      throw new Error('log_permission_denied: 暂无该云日志读权限，请联系管理员申请');
    }
    if (status >= 400) {
      integrationWarn('logcenter', 'upstream HTTP error', { path, status });
      throw new Error(`log_upstream_error: HTTP ${status}`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      integrationWarn('logcenter', 'invalid response body', { path, status });
      throw new Error('log_upstream_error: invalid response body');
    }
    const payload = body as { code?: number; msg?: string; data?: unknown };
    if (payload.code !== undefined && payload.code !== 0) {
      const msg = typeof payload.msg === 'string' ? payload.msg : 'upstream rejected request';
      integrationWarn('logcenter', 'upstream business error', { path, status, code: payload.code, msg });
      if (payload.code === 403) throw new Error(`log_permission_denied: ${msg}`);
      throw new Error(`log_upstream_error: ${msg}`);
    }
    integrationInfo('logcenter', 'request ok', { path, status, code: payload.code ?? 0 });
    return body as Record<string, unknown>;
  }

  async countCloudLogs(input: {
    vendor: string;
    region: string;
    account: string;
    collection: string;
    topic: string;
    start: number;
    end: number;
  }): Promise<{ total: number; elapsed_ms: number }> {
    const body = await this.request(`skill/cloud/${input.vendor}/count`, {
      region: input.region,
      account_ak_id: input.account,
      collection_id: input.collection,
      topic_id: input.topic,
      start: input.start,
      end: input.end,
    });
    const data = (body.data ?? {}) as { total?: number; elapsed_millisecond?: number };
    return {
      total: Number(data.total ?? 0),
      elapsed_ms: Number(data.elapsed_millisecond ?? 0),
    };
  }

  async searchCloudLogs(input: {
    vendor: string;
    region: string;
    account: string;
    collection: string;
    topic: string;
    start: number;
    end: number;
    query: string;
    size: number;
    from: number;
  }): Promise<{ total: number; elapsed_ms: number; logs: unknown[]; progress?: string }> {
    const body = await this.request(`skill/cloud/${input.vendor}/search`, {
      region: input.region,
      account_ak_id: input.account,
      collection_id: input.collection,
      topic_id: input.topic,
      start: input.start,
      end: input.end,
      query: input.query,
      size: input.size,
      from: input.from,
      reverse: false,
    });
    const data = (body.data ?? {}) as {
      total?: number;
      elapsed_millisecond?: number;
      logs?: unknown[];
      progress?: string;
    };
    const logs = Array.isArray(data.logs) ? data.logs.map((item) => truncateValue(item)) : [];
    return {
      total: Number(data.total ?? logs.length),
      elapsed_ms: Number(data.elapsed_millisecond ?? 0),
      logs,
      progress: data.progress,
    };
  }

  async getStorageType(serviceId: number): Promise<{ storage_type: string; alias: string }> {
    const body = await this.request('skill/service/storage-type', { service_id: serviceId });
    const data = (body.data ?? {}) as { storage_type?: string; alias?: string };
    return {
      storage_type: String(data.storage_type ?? ''),
      alias: String(data.alias ?? ''),
    };
  }

  async countServiceLogs(input: {
    serviceId: number;
    start: number;
    end: number;
    query?: string;
  }): Promise<{ total: number }> {
    const params: Record<string, string | number | boolean> = {
      type: 2,
      service_id: input.serviceId,
      start: input.start,
      end: input.end,
      from: 1,
      size: 40,
      tag_from: 2,
      query_interval: 'auto',
      retrieval_type: 2,
    };
    if (input.query?.trim()) params.fuzzy_query = input.query.trim();
    const body = await this.request('skill/search/time', params);
    return { total: Number(body.total ?? 0) };
  }

  async queryServiceLogs(input: {
    serviceId: number;
    start: number;
    end: number;
    query?: string;
    page: number;
    size: number;
  }): Promise<{ total: number; logs: unknown[]; page: number }> {
    const params: Record<string, string | number | boolean> = {
      type: 2,
      service_id: input.serviceId,
      start: input.start,
      end: input.end,
      from: input.page,
      size: input.size,
      tag_from: 2,
      query_interval: 'auto',
      retrieval_type: 2,
    };
    if (input.query?.trim()) params.fuzzy_query = input.query.trim();
    const body = await this.request('skill/search', params);
    const logs = extractLogList(body).map((item) => truncateValue(item));
    return {
      total: Number(body.total ?? logs.length),
      logs,
      page: input.page,
    };
  }
}

const SlsTargetFields = {
  vendor: z.string().min(1).default('aliyun'),
  region: z.string().min(1),
  account: z.string().min(1),
  collection: z.string().min(1),
  topic: z.string().min(1),
  time: z.string().min(1).default('1h'),
  query: z.string().optional(),
};

const ServiceTargetFields = {
  service_id: z.number().int().positive(),
  time: z.string().min(1).default('1h'),
  query: z.string().optional(),
};

export type LogCatalogToolset = {
  resolve_log_target: ReturnType<typeof createTool>;
  count_cloud_logs: ReturnType<typeof createTool>;
  search_cloud_logs: ReturnType<typeof createTool>;
  count_logs: ReturnType<typeof createTool>;
  query_logs: ReturnType<typeof createTool>;
};

export async function createLogCatalogTools(
  config: RuntimeConfig,
  options?: { http?: LogCenterHttp; catalog?: LogCatalog; abortSignal?: AbortSignal },
): Promise<LogCatalogToolset | null> {
  if (!isLogCenterConfigured(config)) {
    integrationWarn('logcenter', 'tools not mounted: credentials missing', {
      appIdConfigured: Boolean(config.logcenterAppId.trim()),
      appSecretConfigured: Boolean(config.logcenterAppSecret.trim()),
    });
    return null;
  }

  const catalogFile = logCatalogPath(config);
  let catalog: LogCatalog;
  try {
    catalog = options?.catalog ?? await loadLogCatalog(catalogFile);
  } catch (error) {
    integrationError('logcenter', 'tools not mounted: catalog load failed', error, {
      catalogPath: catalogFile,
    });
    throw error;
  }
  integrationInfo('logcenter', 'tools mounted', {
    catalogPath: catalogFile,
    baseUrl: config.logcenterBaseUrl || LOGCENTER_DEFAULT_BASE_URL,
    appIdConfigured: true,
    storeCount: catalog.stores?.length ?? 0,
    targetCount: catalog.targets?.length ?? 0,
  });
  const client = new LogCenterClient(
    config.logcenterAppId,
    config.logcenterAppSecret,
    config.logcenterBaseUrl || LOGCENTER_DEFAULT_BASE_URL,
    options?.http,
    { abortSignal: options?.abortSignal, timeoutMs: config.logcenterTimeoutMs },
  );

  return {
    resolve_log_target: createTool({
      id: 'resolve_log_target',
      description:
        'Resolve a business phrase to a catalog target (SLS appid or logcenter APM). Returns source + suggested_query from config. Prefer exact business/appid aliases; vague platform words may be ambiguous. Routing only; not incident evidence.',
      inputSchema: z.strictObject({ query: z.string().min(1).max(400) }),
      execute: async ({ query }) => {
        const result = resolveLogTarget(catalog, query);
        integrationInfo('logcenter', 'resolve_log_target', {
          query: query.slice(0, 120),
          status: result.status,
          candidateCount: result.candidates.length,
          sources: [...new Set(result.candidates.map((c) => c.source))],
        });
        return result;
      },
    }),
    count_cloud_logs: createTool({
      id: 'count_cloud_logs',
      description:
        'Count Aliyun SLS cloud logs for a resolved aliyun_sls target. Prefer after resolve_log_target when source=aliyun_sls.',
      inputSchema: z.object(SlsTargetFields),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        return client.countCloudLogs({
          vendor: input.vendor,
          region: input.region,
          account: input.account,
          collection: input.collection,
          topic: input.topic,
          start: range.start,
          end: range.end,
        });
      },
    }),
    search_cloud_logs: createTool({
      id: 'search_cloud_logs',
      description:
        'Search Aliyun SLS cloud logs for a resolved aliyun_sls target. Prefer catalog suggested_query. Truncated helpers, not ledger evidence.',
      inputSchema: z.object({
        ...SlsTargetFields,
        size: z.number().int().min(1).max(200).default(50),
        from: z.number().int().min(0).default(0),
      }),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        const size = Math.min(input.size ?? 50, 200);
        return client.searchCloudLogs({
          vendor: input.vendor,
          region: input.region,
          account: input.account,
          collection: input.collection,
          topic: input.topic,
          start: range.start,
          end: range.end,
          query: input.query?.trim() || '*',
          size,
          from: input.from ?? 0,
        });
      },
    }),
    count_logs: createTool({
      id: 'count_logs',
      description:
        'Count 未来云日志中心 logs by service_id for a resolved logcenter/client_apm target. Prefer after resolve_log_target when source=logcenter.',
      inputSchema: z.object(ServiceTargetFields),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        return client.countServiceLogs({
          serviceId: input.service_id,
          start: range.start,
          end: range.end,
          query: input.query,
        });
      },
    }),
    query_logs: createTool({
      id: 'query_logs',
      description:
        'Query 未来云日志中心 logs by service_id (Lucene). page starts at 1 (not offset). Prefer catalog suggested_query. Truncated helpers, not ledger evidence.',
      inputSchema: z.object({
        ...ServiceTargetFields,
        page: z.number().int().min(1).default(1),
        size: z.number().int().min(1).max(40).default(40),
      }),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        const size = Math.min(input.size ?? 40, 40);
        return client.queryServiceLogs({
          serviceId: input.service_id,
          start: range.start,
          end: range.end,
          query: input.query,
          page: input.page ?? 1,
          size,
        });
      },
    }),
  };
}
