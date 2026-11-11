import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createTool } from '@mastra/core/tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
import { integrationError, integrationInfo, integrationWarn } from '../observability/integration-log.js';
import {
  CLIENT_LOG_REDACTION_VERSION,
  ClientLogPrivacy,
  type LogIdentifiers,
  type MatchedIdentifier,
} from '../security/log-privacy.js';

export const LOGCENTER_DEFAULT_BASE_URL = 'https://logcenter-api.tal.com/api';
export const LOG_CATALOG_DEFAULT_RELATIVE = 'runtime/contracts/log-catalog/catalog.yaml';

const MatchSchema = z.record(z.string(), z.string()).default({});
const ObservedPlatformSchema = z.enum(['harmony', 'android', 'ios', 'unknown']);

const BusinessSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  match: MatchSchema,
}).strict();

const IdentityFieldsSchema = z.strictObject({
  learner_id: z.array(z.string().min(1)).default([]),
  phone: z.array(z.string().min(1)).default([]),
  trace_id: z.array(z.string().min(1)).default([]),
  request_id: z.array(z.string().min(1)).default([]),
});

const ObservationFieldsSchema = z.strictObject({
  platform: z.array(z.string().min(1)).default([]),
  platform_values: z.record(z.string(), z.enum(['harmony', 'android', 'ios'])).default({}),
  version: z.array(z.string().min(1)).default([]),
  device: z.array(z.string().min(1)).default([]),
  session: z.array(z.string().min(1)).default([]),
});

const AppidSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().default(''),
  key_fields: z.array(z.string().min(1)).default([]),
  businesses: z.array(BusinessSchema).default([]),
  // 只有核实过真实字段语义时才配置；缺省表示该目标不能做身份发现或平台确认。
  identity_fields: IdentityFieldsSchema.optional(),
  observation_fields: ObservationFieldsSchema.optional(),
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
export type ObservedPlatform = z.infer<typeof ObservedPlatformSchema>;

export type LogToolCorrelation = {
  /** 仅 Runtime 内存使用；不得写入工具事件、查询日志或证据。 */
  identifiers: LogIdentifiers;
  /** 当前会话用户原文，仅用于确认 resolve 查询确实来自用户。 */
  sourceText: string;
};

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

type ObservationContext = {
  environment: string;
  storage_alias: string;
  account: string;
  collection: string;
  store_id: string;
  topic: string;
  appid: string;
  query: string;
  start: number;
  end: number;
  page: number;
  entry_id: string;
  redaction_version: string;
  matched_identifiers: MatchedIdentifier[];
  matched_error_features: string[];
  service_binding: {
    status: 'confirmed' | 'unconfirmed';
    method: 'user_selected' | 'observed_client_session' | null;
  };
  observed_platform: ObservedPlatform;
  observed_version: string | null;
  device_ref: string | null;
  session_ref: string | null;
  platform_conflict: boolean;
};

export type ClientLogObservation = {
  entry_id: string;
  timestamp: string | null;
  excerpt: string;
  fields: unknown;
  location: string;
  matched_identifiers: MatchedIdentifier[];
  observation_context: ObservationContext;
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

function quoteQuery(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function buildSuggestedQuery(appid: string, match: Record<string, string>): string {
  const parts = [`appid: ${quoteQuery(appid)}`];
  for (const [key, value] of Object.entries(match)) {
    if (!value) continue;
    parts.push(`${key}: ${quoteQuery(value)}`);
  }
  return parts.join(' and ');
}

function candidateFor(catalog: LogCatalog, hit: AliasHit): LogTargetCandidate {
  return {
    store_id: hit.store.id,
    vendor: hit.store.vendor ?? catalog.vendor,
    region: hit.store.region ?? catalog.defaults.region,
    account: hit.store.account ?? catalog.defaults.account,
    collection: hit.store.collection ?? catalog.defaults.collection,
    topic: hit.store.topic,
    appid: hit.appid.id,
    business: hit.business?.name ?? null,
    suggested_query: buildSuggestedQuery(hit.appid.id, hit.business?.match ?? {}),
    key_fields: hit.appid.key_fields,
    notes: hit.store.notes,
  };
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
      for (const appid of store.appids) hits.push({ store, appid, business: null, score: storeScore });
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
  if (unique.length === 0) return { status: 'not_found', candidates: [] };
  if (unique.length === 1) return { status: 'resolved', candidates: [candidateFor(catalog, unique[0]!)] };
  return { status: 'ambiguous', candidates: unique.map((hit) => candidateFor(catalog, hit)) };
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
      // 上游 msg 可能回显完整查询，集成日志只保留错误码；工具边界再脱敏错误文本。
      integrationWarn('logcenter', 'upstream business error', { path, status, code: payload.code });
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
    query: string;
  }): Promise<{ total: number; elapsed_ms: number }> {
    const body = await this.request(`skill/cloud/${input.vendor}/count`, {
      region: input.region,
      account_ak_id: input.account,
      collection_id: input.collection,
      topic_id: input.topic,
      start: input.start,
      end: input.end,
      query: input.query,
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
    return {
      total: Number(data.total ?? (Array.isArray(data.logs) ? data.logs.length : 0)),
      elapsed_ms: Number(data.elapsed_millisecond ?? 0),
      logs: Array.isArray(data.logs) ? data.logs : [],
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
  appid: z.string().min(1).optional(),
  time: z.string().min(1).default('1h'),
  query: z.string().optional(),
};

type TargetInput = {
  vendor: string;
  region: string;
  account: string;
  collection: string;
  topic: string;
  appid?: string;
  time: string;
  query?: string;
};

function targetKey(target: {
  vendor: string;
  region: string;
  account: string;
  collection: string;
  topic: string;
  appid: string;
}): string {
  return JSON.stringify([
    target.vendor, target.region, target.account, target.collection, target.topic, target.appid,
  ]);
}

function fieldValues(entry: unknown, path: string): unknown[] {
  let value = entry;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    value = (value as Record<string, unknown>)[segment];
  }
  return Array.isArray(value) ? value.slice(0, 10) : [value];
}

function textField(entry: unknown, paths: string[] | undefined): string | null {
  for (const path of paths ?? []) {
    for (const value of fieldValues(entry, path)) {
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

function parsePlatform(value: string, configured: Record<string, 'harmony' | 'android' | 'ios'>): Exclude<ObservedPlatform, 'unknown'> | null {
  const exact = configured[value] ?? configured[value.trim().toLocaleLowerCase()];
  if (exact) return exact;
  const normalized = value.trim().toLocaleLowerCase();
  if (/harmony\s*os|openharmony|\bohos\b|\bhmos\b/.test(normalized)) return 'harmony';
  if (/\bandroid\b/.test(normalized)) return 'android';
  if (/\bios\b|\biphone\b|\bipad\b/.test(normalized)) return 'ios';
  return null;
}

function observationTimestamp(entry: unknown): string | null {
  for (const key of ['@timestamp', 'timestamp', 'time', '__time__']) {
    const value = textField(entry, [key]);
    if (value) return value.slice(0, 100);
  }
  return null;
}

function aggregatePlatform(entries: ClientLogObservation[]): { platform: ObservedPlatform; conflict: boolean } {
  const values = new Set(entries.map((entry) => entry.observation_context.observed_platform));
  const recognized = new Set([...values].filter((value) => value !== 'unknown'));
  if (values.size === 1 && recognized.size === 1) return { platform: [...recognized][0]!, conflict: false };
  return { platform: 'unknown', conflict: values.size > 1 };
}

export async function createLogCatalogTools(
  config: RuntimeConfig,
  options?: {
    http?: LogCenterHttp;
    catalog?: LogCatalog;
    abortSignal?: AbortSignal;
    correlation?: LogToolCorrelation;
  },
): Promise<{
  resolve_log_target: ReturnType<typeof createTool>;
  count_cloud_logs: ReturnType<typeof createTool>;
  search_cloud_logs: ReturnType<typeof createTool>;
  discover_client_sessions: ReturnType<typeof createTool>;
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
    integrationError('logcenter', 'tools not mounted: catalog load failed', error, { catalogPath: catalogFile });
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
    { abortSignal: options?.abortSignal, timeoutMs: config.logcenterTimeoutMs },
  );
  const privacy = new ClientLogPrivacy(options?.correlation?.identifiers ?? {});
  const bindings = new Map<string, 'user_selected' | 'observed_client_session'>();
  const identifiers = options?.correlation?.identifiers ?? {};

  const safeText = (value: unknown): string => String(privacy.sanitize(value).value);
  const rethrowSafe = (error: unknown): never => {
    if (error && typeof error === 'object' && 'name' in error && ['AbortError', 'TimeoutError'].includes(String(error.name))) {
      throw error;
    }
    throw new Error(safeText(error instanceof Error ? error.message : String(error)));
  };

  const appidFor = (candidate: LogTargetCandidate) => catalog.stores
    .find((store) => store.id === candidate.store_id && store.topic === candidate.topic)
    ?.appids.find((appid) => appid.id === candidate.appid);
  const storeFor = (candidate: LogTargetCandidate) => catalog.stores
    .find((store) => store.id === candidate.store_id && store.topic === candidate.topic);

  const bind = (candidate: LogTargetCandidate, method: 'user_selected' | 'observed_client_session') => {
    bindings.set(targetKey(candidate), method);
  };

  const boundCandidate = (input: TargetInput): { candidate: LogTargetCandidate; method: 'user_selected' | 'observed_client_session' } => {
    if (!input.appid) throw new Error('log_target_unbound: 请从 resolve_log_target 候选中传入 appid，不能省略或自行猜测');
    let candidate: LogTargetCandidate | undefined;
    for (const store of catalog.stores) {
      for (const appid of store.appids) {
        const current = candidateFor(catalog, { store, appid, business: null, score: 0 });
        if (targetKey(current) === targetKey({ ...input, appid: input.appid })) candidate = current;
      }
    }
    const method = candidate ? bindings.get(targetKey(candidate)) : undefined;
    if (!candidate || !method) {
      throw new Error('log_target_unbound: 请先用用户原文中的业务词执行 resolve_log_target，并逐字使用已绑定坐标');
    }
    return { candidate, method };
  };

  const scopedQuery = (candidate: LogTargetCandidate, query: string | undefined): string => {
    const appidCondition = `appid: ${quoteQuery(candidate.appid)}`;
    const normalized = query?.trim();
    if (!normalized || normalized === '*') return appidCondition;
    if (normalized.includes(appidCondition)) return normalized;
    return `${appidCondition} and (${normalized})`;
  };

  const observe = (
    candidate: LogTargetCandidate,
    raw: unknown,
    context: {
      query: string;
      start: number;
      end: number;
      page: number;
      method: 'user_selected' | 'observed_client_session';
    },
  ): ClientLogObservation => {
    const sanitized = privacy.sanitize(raw);
    const matched = sanitized.matched_identifiers;
    const appid = appidFor(candidate);
    const store = storeFor(candidate);
    const observationFields = appid?.observation_fields;
    const rawPlatforms = (observationFields?.platform ?? [])
      .flatMap((path) => fieldValues(raw, path))
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .map(String);
    const parsedPlatforms = new Set(rawPlatforms
      .map((value) => parsePlatform(value, observationFields?.platform_values ?? {}))
      .filter((value): value is 'harmony' | 'android' | 'ios' => value !== null));
    const platformConflict = parsedPlatforms.size > 1;
    const observedPlatform = matched.length > 0 && parsedPlatforms.size === 1
      ? [...parsedPlatforms][0]!
      : 'unknown';
    const entryId = privacy.entryId({
      store: candidate.store_id,
      appid: candidate.appid,
      timestamp: observationTimestamp(raw),
      entry: raw,
    });
    const bindingConfirmed = matched.length > 0 || context.method === 'user_selected';
    const device = textField(raw, observationFields?.device);
    const session = textField(raw, observationFields?.session);
    const version = matched.length > 0 ? textField(raw, observationFields?.version) : null;
    const observationContext: ObservationContext = {
      environment: store?.env ?? 'unknown',
      storage_alias: candidate.vendor,
      account: candidate.account,
      collection: candidate.collection,
      store_id: candidate.store_id,
      topic: candidate.topic,
      appid: candidate.appid,
      query: safeText(context.query),
      start: context.start,
      end: context.end,
      page: context.page,
      entry_id: entryId,
      redaction_version: CLIENT_LOG_REDACTION_VERSION,
      matched_identifiers: matched,
      matched_error_features: [],
      service_binding: {
        status: bindingConfirmed ? 'confirmed' : 'unconfirmed',
        method: bindingConfirmed ? context.method : null,
      },
      observed_platform: observedPlatform,
      observed_version: version ? safeText(version) : null,
      device_ref: device ? privacy.pseudonym('device_id', device) : null,
      session_ref: session ? privacy.pseudonym('session_id', session) : null,
      platform_conflict: matched.length > 0 && platformConflict,
    };
    const excerpt = Array.from(JSON.stringify(sanitized.value) ?? 'null').slice(0, 2_000).join('');
    return {
      entry_id: entryId,
      timestamp: observationTimestamp(raw) ? safeText(observationTimestamp(raw)) : null,
      excerpt,
      fields: sanitized.value,
      location: `logcenter://${observationContext.environment}/${candidate.store_id}/${candidate.appid}#${entryId}`,
      matched_identifiers: matched,
      observation_context: observationContext,
    };
  };

  const searchTarget = async (
    binding: { candidate: LogTargetCandidate; method: 'user_selected' | 'observed_client_session' },
    input: {
      time: string;
      query?: string;
      size: number;
      from: number;
      range?: { start: number; end: number };
    },
  ) => {
    const range = input.range ?? parseTimeRangeSeconds(input.time);
    const query = scopedQuery(binding.candidate, input.query);
    const raw = await client.searchCloudLogs({
      ...binding.candidate,
      start: range.start,
      end: range.end,
      query,
      size: Math.min(input.size, 50),
      from: input.from,
    });
    const entries = raw.logs.map((entry) => observe(binding.candidate, entry, {
      query,
      start: range.start,
      end: range.end,
      page: input.from,
      method: binding.method,
    }));
    const correlated = entries.filter((entry) => entry.matched_identifiers.length > 0
      && entry.observation_context.service_binding.status === 'confirmed');
    return {
      total: raw.total,
      elapsed_ms: raw.elapsed_ms,
      progress: raw.progress,
      start: range.start,
      end: range.end,
      query: safeText(query),
      logs: entries.map((entry) => entry.fields),
      entries,
      observation_status: entries.length === 0 ? 'empty' : correlated.length > 0 ? 'correlated' : 'uncorrelated',
      limitations: entries.length === 0
        ? ['查询为空：只表示已尝试观察，不能确认平台或故障']
        : correlated.length === 0
          ? ['返回条目未匹配当前学员/设备/请求标识，不能作为本次故障的关联观测']
          : [],
    };
  };

  return {
    resolve_log_target: createTool({
      id: 'resolve_log_target',
      description: 'Resolve a business phrase to Aliyun SLS coordinates using the built-in log catalog. Routing only; not incident evidence.',
      inputSchema: z.strictObject({ query: z.string().min(1).max(400) }),
      execute: async ({ query }) => {
        const result = resolveLogTarget(catalog, query);
        const userSelected = result.status === 'resolved'
          && Boolean(options?.correlation?.sourceText.includes(query));
        if (userSelected) bind(result.candidates[0]!, 'user_selected');
        integrationInfo('logcenter', 'resolve_log_target', {
          query: safeText(query.slice(0, 120)),
          status: result.status,
          candidateCount: result.candidates.length,
          targetBound: userSelected,
        });
        return {
          ...result,
          target_binding: {
            status: userSelected ? 'confirmed' : 'unconfirmed',
            method: userSelected ? 'user_selected' : null,
          },
        };
      },
    }),
    count_cloud_logs: createTool({
      id: 'count_cloud_logs',
      description: 'Count logs for a resolved and runtime-bound target. Query is scoped to the bound appid; not diagnosis evidence.',
      inputSchema: z.object(TargetFields),
      execute: async (input) => {
        try {
          const binding = boundCandidate(input);
          const range = parseTimeRangeSeconds(input.time);
          return await client.countCloudLogs({
            ...binding.candidate,
            start: range.start,
            end: range.end,
            query: scopedQuery(binding.candidate, input.query),
          });
        } catch (error) {
          rethrowSafe(error);
        }
      },
    }),
    search_cloud_logs: createTool({
      id: 'search_cloud_logs',
      description: 'Search a resolved and runtime-bound target. Results are PII-sanitized observations; only identity-correlated entries can enter the evidence ledger.',
      inputSchema: z.object({
        ...TargetFields,
        size: z.number().int().min(1).max(50).default(20),
        from: z.number().int().min(0).default(0),
      }),
      execute: async (input) => {
        try {
          return await searchTarget(boundCandidate(input), {
            time: input.time,
            query: input.query,
            size: input.size,
            from: input.from,
          });
        } catch (error) {
          rethrowSafe(error);
        }
      },
    }),
    discover_client_sessions: createTool({
      id: 'discover_client_sessions',
      description: 'Discover client devices/sessions using runtime-injected learner identifiers. Raw identifiers are never model arguments; observed_platform requires identity-matched actual platform fields.',
      inputSchema: z.strictObject({
        time: z.string().min(1).default('1h'),
        size: z.number().int().min(1).max(10).default(10),
      }),
      execute: async ({ time, size }) => {
        const supported = (['learner_id', 'phone', 'trace_id', 'request_id'] as const)
          .filter((kind) => identifiers[kind]?.trim());
        if (supported.length === 0) {
          throw new Error('log_identity_required: 需要用户明确提供的学员编号、联系电话、traceId 或 requestId');
        }
        const targets: Array<{ candidate: LogTargetCandidate; query: string }> = [];
        const uncovered = new Set<string>();
        for (const store of catalog.stores) {
          let storeCovered = false;
          for (const appid of store.appids) {
            const fields = appid.identity_fields;
            const conditions: string[] = [];
            for (const kind of supported) {
              const value = identifiers[kind]!;
              for (const field of fields?.[kind] ?? []) {
                // 未声明为 key_fields 的身份字段不能假装可查询。
                if (appid.key_fields.includes(field)) conditions.push(`${field}: ${quoteQuery(value)}`);
              }
            }
            if (conditions.length === 0) continue;
            storeCovered = true;
            const candidate = candidateFor(catalog, { store, appid, business: null, score: 0 });
            targets.push({ candidate, query: conditions.join(' or ') });
          }
          if (!storeCovered) uncovered.add(store.id);
        }
        if (targets.length === 0) {
          return {
            status: 'not_covered',
            observed_platform: 'unknown',
            platform_conflict: false,
            candidates: [],
            uncovered_store_ids: [...uncovered],
            limitations: ['Catalog 没有已核实且可查询的身份字段，未执行日志检索'],
          };
        }
        const bounded = targets.slice(0, 6);
        const candidates: unknown[] = [];
        const allEntries: ClientLogObservation[] = [];
        const errors: string[] = [];
        for (const target of bounded) {
          bind(target.candidate, 'observed_client_session');
          const range = parseTimeRangeSeconds(time);
          const query = scopedQuery(target.candidate, target.query);
          try {
            const count = await client.countCloudLogs({
              ...target.candidate,
              start: range.start,
              end: range.end,
              query,
            });
            if (count.total === 0) {
              candidates.push({
                store_id: target.candidate.store_id,
                appid: target.candidate.appid,
                total: 0,
                entries: [],
                observed_platform: 'unknown',
                observed_versions: [],
              });
              continue;
            }
            const result = await searchTarget(
              { candidate: target.candidate, method: 'observed_client_session' },
              { time, query: target.query, size, from: 0, range },
            );
            const entries = result.entries.filter((entry) => entry.matched_identifiers.length > 0);
            allEntries.push(...entries);
            const aggregate = aggregatePlatform(entries);
            candidates.push({
              store_id: target.candidate.store_id,
              appid: target.candidate.appid,
              total: result.total,
              entries,
              observed_platform: aggregate.platform,
              platform_conflict: aggregate.conflict,
              observed_versions: [...new Set(entries
                .map((entry) => entry.observation_context.observed_version)
                .filter((value): value is string => Boolean(value)))],
              device_refs: [...new Set(entries
                .map((entry) => entry.observation_context.device_ref)
                .filter((value): value is string => Boolean(value)))],
              session_refs: [...new Set(entries
                .map((entry) => entry.observation_context.session_ref)
                .filter((value): value is string => Boolean(value)))],
            });
          } catch (error) {
            if (error && typeof error === 'object' && 'name' in error
                && ['AbortError', 'TimeoutError'].includes(String(error.name))) throw error;
            errors.push(safeText(error instanceof Error ? error.message : String(error)));
          }
        }
        const aggregate = aggregatePlatform(allEntries);
        return {
          status: errors.length > 0 ? 'degraded' : allEntries.length > 0 ? 'resolved' : 'not_found',
          observed_platform: aggregate.platform,
          platform_conflict: aggregate.conflict,
          candidates,
          errors,
          uncovered_store_ids: [...uncovered],
          truncated: targets.length > bounded.length,
          limitations: [
            ...(targets.length > bounded.length ? [`仅查询前 ${bounded.length} 个已配置目标，其余目标未覆盖`] : []),
            ...(uncovered.size > 0 ? ['部分 store 未配置可查询身份字段，未纳入发现范围'] : []),
            ...(allEntries.length === 0 && errors.length === 0 ? ['未发现身份匹配日志，不能确认设备、会话或平台'] : []),
          ],
        };
      },
    }),
  };
}
