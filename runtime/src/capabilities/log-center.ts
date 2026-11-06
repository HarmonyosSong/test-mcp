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

const AppidSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().default(''),
  key_fields: z.array(z.string().min(1)).default([]),
  businesses: z.array(BusinessSchema).default([]),
}).strict();

const StoreSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  env: z.enum(['prod', 'test']).default('prod'),
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().default(''),
  notes: z.array(z.string()).default([]),
  region: z.string().optional(),
  account: z.string().optional(),
  collection: z.string().optional(),
  vendor: z.string().optional(),
  appids: z.array(AppidSchema).default([]),
}).strict();

export const LogCatalogSchema = z.object({
  version: z.number().int().positive(),
  vendor: z.string().min(1).default('aliyun'),
  defaults: z.object({
    region: z.string().min(1),
    account: z.string().min(1),
    collection: z.string().min(1),
    time: z.string().min(1).default('1h'),
  }).strict(),
  stores: z.array(StoreSchema).min(1),
}).strict();

export type LogCatalog = z.infer<typeof LogCatalogSchema>;

export type LogTargetCandidate = {
  store_id: string;
  vendor: string;
  region: string;
  account: string;
  collection: string;
  topic: string;
  appid: string;
  business: string | null;
  suggested_query: string;
  key_fields: string[];
  notes: string[];
};

export type ResolveLogTargetResult = {
  status: 'resolved' | 'ambiguous' | 'not_found';
  candidates: LogTargetCandidate[];
};

type AliasHit = {
  store: z.infer<typeof StoreSchema>;
  appid: z.infer<typeof AppidSchema>;
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

function buildSuggestedQuery(appid: string, match: Record<string, string>): string {
  const parts = [`appid: "${appid}"`];
  for (const [key, value] of Object.entries(match)) {
    if (!value) continue;
    parts.push(`${key}: "${value}"`);
  }
  return parts.join(' and ');
}

export function resolveLogTarget(catalog: LogCatalog, query: string): ResolveLogTargetResult {
  const hits: AliasHit[] = [];
  for (const store of catalog.stores) {
    for (const appid of store.appids) {
      for (const business of appid.businesses) {
        const score = bestAliasScore(query, [business.name, ...business.aliases], 30);
        if (score > 0) hits.push({ store, appid, business, score });
      }
      const appScore = bestAliasScore(query, [appid.id, ...appid.aliases], 20);
      if (appScore > 0) hits.push({ store, appid, business: null, score: appScore });
    }
    const storeScore = bestAliasScore(query, [store.id, store.topic, ...store.aliases], 10);
    if (storeScore > 0) {
      for (const appid of store.appids) {
        hits.push({ store, appid, business: null, score: storeScore });
      }
    }
  }

  const best = Math.max(0, ...hits.map((hit) => hit.score));
  const filtered = hits.filter((hit) => hit.score === best && best > 0);
  const dedup = new Map<string, AliasHit>();
  for (const hit of filtered) {
    const key = `${hit.store.id}\0${hit.appid.id}\0${hit.business?.name ?? ''}`;
    if (!dedup.has(key)) dedup.set(key, hit);
  }
  const unique = [...dedup.values()];

  const toCandidate = (hit: AliasHit): LogTargetCandidate => {
    const match = hit.business?.match ?? {};
    return {
      store_id: hit.store.id,
      vendor: hit.store.vendor ?? catalog.vendor,
      region: hit.store.region ?? catalog.defaults.region,
      account: hit.store.account ?? catalog.defaults.account,
      collection: hit.store.collection ?? catalog.defaults.collection,
      topic: hit.store.topic,
      appid: hit.appid.id,
      business: hit.business?.name ?? null,
      suggested_query: buildSuggestedQuery(hit.appid.id, match),
      key_fields: hit.appid.key_fields,
      notes: hit.store.notes,
    };
  };

  if (unique.length === 0) return { status: 'not_found', candidates: [] };
  if (unique.length === 1) return { status: 'resolved', candidates: [toCandidate(unique[0]!)] };
  return { status: 'ambiguous', candidates: unique.map(toCandidate) };
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

export type LogCenterHttp = (input: {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; body: unknown }>;

async function defaultHttp(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<{ status: number; body: unknown }> {
  const response = await fetch(input.url, { method: input.method, headers: input.headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

export class LogCenterClient {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly baseUrl: string,
    private readonly http: LogCenterHttp = defaultHttp,
  ) {}

  private endpoint(path: string, params: Record<string, string | number | boolean>): string {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async request(path: string, params: Record<string, string | number | boolean>): Promise<Record<string, unknown>> {
    const url = this.endpoint(path, params);
    integrationInfo('logcenter', 'request start', {
      path,
      baseUrl: this.baseUrl,
      region: params.region,
      collection: params.collection_id,
      topic: params.topic_id,
      accountConfigured: Boolean(params.account_ak_id),
    });
    const { status, body } = await this.http({
      method: 'GET',
      url,
      headers: signHeaders(this.appId, this.appSecret),
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
}

const TargetFields = {
  vendor: z.string().min(1).default('aliyun'),
  region: z.string().min(1),
  account: z.string().min(1),
  collection: z.string().min(1),
  topic: z.string().min(1),
  time: z.string().min(1).default('1h'),
  query: z.string().optional(),
};

export async function createLogCatalogTools(
  config: RuntimeConfig,
  options?: { http?: LogCenterHttp; catalog?: LogCatalog },
): Promise<{
  resolve_log_target: ReturnType<typeof createTool>;
  count_cloud_logs: ReturnType<typeof createTool>;
  search_cloud_logs: ReturnType<typeof createTool>;
} | null> {
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
  });
  const client = new LogCenterClient(
    config.logcenterAppId,
    config.logcenterAppSecret,
    config.logcenterBaseUrl || LOGCENTER_DEFAULT_BASE_URL,
    options?.http,
  );

  return {
    resolve_log_target: createTool({
      id: 'resolve_log_target',
      description: 'Resolve a business phrase to Aliyun SLS coordinates using the built-in log catalog. Routing only; not incident evidence.',
      inputSchema: z.strictObject({ query: z.string().min(1).max(400) }),
      execute: async ({ query }) => {
        const result = resolveLogTarget(catalog, query);
        integrationInfo('logcenter', 'resolve_log_target', {
          query: query.slice(0, 120),
          status: result.status,
          candidateCount: result.candidates.length,
        });
        return result;
      },
    }),
    count_cloud_logs: createTool({
      id: 'count_cloud_logs',
      description: 'Count cloud logs for a resolved store target. Prefer after resolve_log_target. Not diagnosis evidence until a later integration decides otherwise.',
      inputSchema: z.object(TargetFields),
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
      description: 'Search cloud logs for a resolved store target. Prefer catalog suggested_query. Results are truncated helpers, not ledger evidence in this phase.',
      inputSchema: z.object({
        ...TargetFields,
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
  };
}
