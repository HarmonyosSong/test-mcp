import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createTool } from '@mastra/core/tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
import { ClientProductLineSchema, LogObservationContextSchema } from '../domain/schemas.js';
import { integrationError, integrationInfo, integrationWarn } from '../observability/integration-log.js';
import {
  CLIENT_LOG_REDACTION_VERSION,
  ClientLogPrivacy,
  type LogIdentifiers,
  type MatchedIdentifier,
} from '../security/log-privacy.js';
import {
  applyResolvedUidQuery,
  createUcenterClient,
  looksLikeLearnerCard,
  resolveLearnerUid,
  type LogQueryStyle,
} from './ucenter.js';

export const LOGCENTER_DEFAULT_BASE_URL = 'https://logcenter-api.tal.com/api';
export const LOG_CATALOG_DEFAULT_RELATIVE = 'runtime/contracts/log-catalog/catalog.yaml';

const MatchSchema = z.record(z.string(), z.string()).default({});
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
  product_line: ClientProductLineSchema.nullable().optional(),
  identity_fields: IdentityFieldsSchema.optional(),
  observation_fields: ObservationFieldsSchema.optional(),
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
type ObservationFields = z.infer<typeof ObservationFieldsSchema>;

/** Runtime-only context used to correlate a log lookup with the current user report. */
export type LogToolCorrelation = {
  identifiers: LogIdentifiers;
  sourceText: string;
  /** 学员编号来源；card 需在挂载工具前转为 uid，禁止直接当 uid 查日志。 */
  learnerIdSource?: 'card' | 'uid';
};

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
  product_line: z.infer<typeof ClientProductLineSchema> | null;
  suggested_query: string;
  /** How Runtime/agent should filter appid/uid on this SLS target. */
  query_style: LogQueryStyle;
  key_fields: string[];
  monitor_types: Record<string, string>;
  notes: string[];
};

type ClientLogObservation = {
  entry_id: string;
  timestamp: string | null;
  excerpt: string;
  fields: unknown;
  location: string;
  matched_identifiers: MatchedIdentifier[];
  observation_context: z.infer<typeof LogObservationContextSchema>;
};

export type ResolveLogTargetResult = {
  status: 'resolved' | 'ambiguous' | 'not_found';
  candidates: LogTargetCandidate[];
  /** Same-feature multi-end (SLS h5 + client), not a pick-one conflict. */
  multi_end?: true;
  strategy?: 'h5_first_then_ua';
  preferred_first?: LogTargetCandidate[];
  next_after_ua?: LogTargetCandidate[];
  requires_uid?: true;
  guidance?: string;
};

const MULTI_END_GUIDANCE =
  '非冲突：同一功能的 H5 与客户端埋点。先确认 uid，再查 preferred_first（H5），从命中读 ua/OS/bundle 定端后，再查 next_after_ua 对应客户端。';

/** SLS multi-hit with both h5 and non-h5 → same feature, combine-query strategy. */
export function attachMultiEndStrategy(
  candidates: LogTargetCandidate[],
): Pick<ResolveLogTargetResult, 'multi_end' | 'strategy' | 'preferred_first' | 'next_after_ua' | 'requires_uid' | 'guidance'> | null {
  if (candidates.length < 2) return null;
  if (!candidates.every((c) => c.source === 'aliyun_sls')) return null;
  const preferred_first = candidates.filter((c) => c.platform === 'h5');
  const next_after_ua = candidates.filter((c) => c.platform !== 'h5');
  if (preferred_first.length === 0 || next_after_ua.length === 0) return null;
  return {
    multi_end: true,
    strategy: 'h5_first_then_ua',
    preferred_first,
    next_after_ua,
    requires_uid: true,
    guidance: MULTI_END_GUIDANCE,
  };
}

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

const FULLTEXT_QUERY_NOTES = new Set(['use_fulltext_or_where', 'appid_not_sql_groupable']);

export function slsQueryStyleFromNotes(notes: readonly string[]): LogQueryStyle {
  return notes.some((note) => FULLTEXT_QUERY_NOTES.has(note)) ? 'fulltext' : 'kv';
}

/** Resolve SLS query dialect from store/topic notes (cloudlearn → fulltext). */
export function resolveSlsQueryStyle(catalog: LogCatalog, topic: string): LogQueryStyle {
  const store = catalog.stores.find((item) => item.id === topic || item.topic === topic);
  if (!store) return 'kv';
  const targetNotes = catalog.targets
    .filter((target) => target.source === 'aliyun_sls' && target.store_ref === store.id)
    .flatMap((target) => target.notes);
  return slsQueryStyleFromNotes([...store.notes, ...targetNotes]);
}

function buildSlsSuggestedQuery(
  appid: string,
  match: Record<string, string>,
  style: LogQueryStyle,
): string {
  if (style === 'fulltext') {
    const parts = [`"${appid}"`];
    for (const value of Object.values(match)) {
      if (!value) continue;
      parts.push(`"${value}"`);
    }
    return parts.join(' and ');
  }
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
      product_line: target.product_line ?? null,
      suggested_query: target.suggested_query || '*',
      query_style: 'kv',
      key_fields: target.key_fields,
      monitor_types: target.monitor_types,
      notes: target.notes,
    };
  }
  const store = resolveStore(catalog, target.store_ref);
  const notes = [...target.notes, ...(store?.notes ?? [])];
  const queryStyle = slsQueryStyleFromNotes(notes);
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
    product_line: target.product_line ?? null,
    suggested_query: target.suggested_query || buildSlsSuggestedQuery(target.id, match, queryStyle),
    query_style: queryStyle,
    key_fields: target.key_fields,
    monitor_types: {},
    notes,
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
  const candidates = unique.map((hit) => toCandidate(catalog, hit));
  const multiEnd = attachMultiEndStrategy(candidates);
  return multiEnd
    ? { status: 'ambiguous', candidates, ...multiEnd }
    : { status: 'ambiguous', candidates };
}

function localParts(ms: number): { y: number; m: number; d: number; H: number; M: number; S: number } {
  const date = new Date(ms);
  return {
    y: date.getFullYear(),
    m: date.getMonth() + 1,
    d: date.getDate(),
    H: date.getHours(),
    M: date.getMinutes(),
    S: date.getSeconds(),
  };
}

function localSeconds(y: number, m: number, d: number, H = 0, M = 0, S = 0): number {
  return Math.floor(new Date(y, m - 1, d, H, M, S).getTime() / 1000);
}

/**
 * Align with logcenterskill parse_time_range: relative, 今天/昨天, YYYY-MM-DD,
 * day+slot, and agent-style `YYYY-MM-DD HH:MM:SS~YYYY-MM-DD HH:MM:SS`.
 */
export function parseTimeRangeSeconds(time: string, nowMs = Date.now()): { start: number; end: number } {
  const original = time.trim();
  if (!original) throw new Error(`log_invalid_request: unsupported time range "${time}"`);
  const now = localParts(nowMs);
  const endNow = Math.floor(nowMs / 1000);

  // Absolute window with ~ (agent often emits seconds): 2026-11-11 07:00:00~2026-11-11 07:40:00
  const tilde = original.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[~～]\s*(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (tilde) {
    return {
      start: localSeconds(+tilde[1]!, +tilde[2]!, +tilde[3]!, +tilde[4]!, +tilde[5]!, +(tilde[6] ?? 0)),
      end: localSeconds(+tilde[7]!, +tilde[8]!, +tilde[9]!, +tilde[10]!, +tilde[11]!, +(tilde[12] ?? 0)),
    };
  }

  // 今天/昨天/前天 HH:MM到HH:MM
  const daySlot = original.match(
    /^(今天|昨天|前天|today|yesterday)\s*(\d{1,2}):(\d{2})\s*(?:到|至|-)\s*(\d{1,2}):(\d{2})$/i,
  );
  if (daySlot) {
    const label = daySlot[1]!.toLowerCase();
    let base = new Date(nowMs);
    if (label === '昨天' || label === 'yesterday') base = new Date(nowMs - 86_400_000);
    if (label === '前天') base = new Date(nowMs - 2 * 86_400_000);
    const p = localParts(base.getTime());
    return {
      start: localSeconds(p.y, p.m, p.d, +daySlot[2]!, +daySlot[3]!),
      end: localSeconds(p.y, p.m, p.d, +daySlot[4]!, +daySlot[5]!),
    };
  }

  // YYYY-MM-DD HH:MM到HH:MM (optional seconds omitted)
  const dateSlot = original.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:到|至|-)\s*(\d{1,2}):(\d{2})(?::\d{2})?$/,
  );
  if (dateSlot) {
    return {
      start: localSeconds(+dateSlot[1]!, +dateSlot[2]!, +dateSlot[3]!, +dateSlot[4]!, +dateSlot[5]!),
      end: localSeconds(+dateSlot[1]!, +dateSlot[2]!, +dateSlot[3]!, +dateSlot[6]!, +dateSlot[7]!),
    };
  }

  const raw = original.toLowerCase();

  // Relative: 15m / 1h / 3d / 1w
  const relative = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days|w|week|weeks)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    const minutes = ['h', 'hour', 'hours'].includes(unit)
      ? amount * 60
      : ['d', 'day', 'days'].includes(unit)
        ? amount * 60 * 24
        : ['w', 'week', 'weeks'].includes(unit)
          ? amount * 60 * 24 * 7
          : amount;
    return { start: endNow - minutes * 60, end: endNow };
  }

  if (raw === '今天' || raw === 'today') {
    return { start: localSeconds(now.y, now.m, now.d), end: endNow };
  }
  if (raw === '昨天' || raw === 'yesterday') {
    const y = new Date(nowMs - 86_400_000);
    const p = localParts(y.getTime());
    return { start: localSeconds(p.y, p.m, p.d), end: localSeconds(p.y, p.m, p.d, 23, 59, 59) };
  }
  if (raw === '前天') {
    const y = new Date(nowMs - 2 * 86_400_000);
    const p = localParts(y.getTime());
    return { start: localSeconds(p.y, p.m, p.d), end: localSeconds(p.y, p.m, p.d, 23, 59, 59) };
  }
  if (raw === '本周' || raw === 'this week' || raw === '这周') {
    const weekday = (new Date(nowMs).getDay() + 6) % 7; // Mon=0
    const monday = new Date(nowMs - weekday * 86_400_000);
    const p = localParts(monday.getTime());
    return { start: localSeconds(p.y, p.m, p.d), end: endNow };
  }
  if (raw === '上周' || raw === 'last week' || raw === '上一周') {
    const weekday = (new Date(nowMs).getDay() + 6) % 7;
    const lastMonday = new Date(nowMs - (weekday + 7) * 86_400_000);
    const lastSunday = new Date(lastMonday.getTime() + 6 * 86_400_000);
    const a = localParts(lastMonday.getTime());
    const b = localParts(lastSunday.getTime());
    return { start: localSeconds(a.y, a.m, a.d), end: localSeconds(b.y, b.m, b.d, 23, 59, 59) };
  }

  const pastDays = raw.match(/^过去\s*(\d+)\s*天$/);
  if (pastDays) {
    const days = Number(pastDays[1]);
    const startDay = new Date(nowMs - days * 86_400_000);
    const p = localParts(startDay.getTime());
    return { start: localSeconds(p.y, p.m, p.d), end: endNow };
  }

  // Absolute day: YYYY-MM-DD
  const dayOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dayOnly) {
    const y = +dayOnly[1]!;
    const m = +dayOnly[2]!;
    const d = +dayOnly[3]!;
    return { start: localSeconds(y, m, d), end: localSeconds(y, m, d, 23, 59, 59) };
  }

  throw new Error(`log_invalid_request: unsupported time range "${time}"`);
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

function fieldValues(entry: unknown, path: string): unknown[] {
  let value = entry;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    value = (value as Record<string, unknown>)[segment];
  }
  return Array.isArray(value) ? value.slice(0, 10) : [value];
}

function textField(entry: unknown, paths: readonly string[] | undefined): string | null {
  for (const path of paths ?? []) {
    for (const value of fieldValues(entry, path)) {
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

function inferredClientVersion(entry: unknown): string | null {
  const text = ['ua', 'rsd', 'version'].flatMap((path) => fieldValues(entry, path))
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return text.match(/(?:XES(?:IPS|PyIOS)|version)[\/=\s]+(\d+\.\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? null;
}

function inferredClientFormFactor(entry: unknown): 'phone' | 'pad' | 'universal' | 'unknown' {
  const text = ['ua', 'rsd'].flatMap((path) => fieldValues(entry, path))
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLocaleLowerCase();
  if (/ipad|\bhd\b|tablet/.test(text)) return 'pad';
  if (/iphone|android|phone/.test(text)) return 'phone';
  return 'unknown';
}

function inferredClientProductLine(entry: unknown): 'xueersi' | 'xuejiayun' | null {
  const text = ['ua', 'rsd', 'bundleName'].flatMap((path) => fieldValues(entry, path))
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  if (/YunXueXi|xuejiayun|学家云/i.test(text)) return 'xuejiayun';
  if (/xueersi|学而思/i.test(text)) return 'xueersi';
  return null;
}

function parsePlatform(value: string, configured: Record<string, 'harmony' | 'android' | 'ios'>): 'harmony' | 'android' | 'ios' | null {
  const exact = configured[value] ?? configured[value.trim().toLocaleLowerCase()];
  if (exact) return exact;
  const normalized = value.trim().toLocaleLowerCase();
  if (/harmony\s*os|openharmony|\bohos\b|\bhmos\b/.test(normalized)) return 'harmony';
  if (/\bandroid\b/.test(normalized)) return 'android';
  if (/\bios\b|\biphone\b|\bipad\b/.test(normalized)) return 'ios';
  return null;
}

function observationTimestamp(entry: unknown): string | null {
  return textField(entry, ['@timestamp', 'timestamp', 'time', '__time__']);
}

function candidateForService(catalog: LogCatalog, serviceId: number): LogTargetCandidate | null {
  const target = catalog.targets.find((item) => item.source === 'logcenter' && item.service_id === serviceId);
  return target ? toCandidate(catalog, { target, business: null, score: 0 }) : null;
}

function candidateForSlsQuery(catalog: LogCatalog, input: {
  collection: string;
  topic: string;
  query?: string;
}): LogTargetCandidate | null {
  const target = catalog.targets.find((item) => {
    if (item.source !== 'aliyun_sls' || item.store_ref !== input.topic) return false;
    return !input.query || input.query.includes(item.id);
  });
  return target ? toCandidate(catalog, { target, business: null, score: 0 }) : null;
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
      // SLS 的 key:value 语法只对已建索引的字段生效；上游 ParameterInvalid 翻成可纠正指引，避免模型反复重试同一语法。
      const invalidKey = /key \(([^)]+)\) is not config as key value config/i.exec(msg)?.[1];
      if (invalidKey) {
        throw new Error(
          `log_query_invalid_key: 该日志库未将 "${invalidKey}" 配置为索引键，key:value 条件对它无效。` +
          '请改为全文检索（直接写 "短语"，不带 key 前缀）或去掉该条件后重试。',
        );
      }
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
    query?: string;
  }): Promise<{ total: number; elapsed_ms: number }> {
    const params: Record<string, string | number | boolean> = {
      region: input.region,
      account_ak_id: input.account,
      collection_id: input.collection,
      topic_id: input.topic,
      start: input.start,
      end: input.end,
    };
    if (input.query?.trim()) params.query = input.query.trim();
    const body = await this.request(`skill/cloud/${input.vendor}/count`, params);
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
  options?: {
    http?: LogCenterHttp;
    catalog?: LogCatalog;
    abortSignal?: AbortSignal;
    correlation?: LogToolCorrelation;
    fetchImpl?: typeof fetch;
  },
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

  const correlation = options?.correlation
    ? {
        ...options.correlation,
        identifiers: { ...options.correlation.identifiers },
      }
    : undefined;
  let unresolvedLearnerCard = false;
  if (correlation?.identifiers.learner_id) {
    const learnerId = correlation.identifiers.learner_id;
    const learnerIdSource = correlation.learnerIdSource
      ?? (looksLikeLearnerCard(learnerId) ? 'card' : 'uid');
    correlation.learnerIdSource = learnerIdSource;
    const resolved = await resolveLearnerUid(
      {
        learnerId,
        learnerIdSource,
      },
      createUcenterClient(config, options?.fetchImpl),
      options?.abortSignal,
    );
    if (resolved) {
      correlation.identifiers.learner_id = resolved;
      correlation.learnerIdSource = 'uid';
    } else if (learnerIdSource === 'card') {
      // A card is not a LogCenter uid. Keep the tools mounted for routing, but
      // block every log request until the conversion succeeds.
      unresolvedLearnerCard = true;
      delete correlation.identifiers.learner_id;
    }
  }
  const resolvedUid = correlation?.identifiers.learner_id;
  const applyLogUidQuery = (
    query: string | undefined,
    options?: { topic?: string },
  ): string | undefined => {
    if (unresolvedLearnerCard) {
      throw new Error('learner_uid_unresolved: 学员编号未成功转换为 uid，已阻止 LogCenter 查询；请检查 UCenter 配置或改用 uid');
    }
    const style = options?.topic ? resolveSlsQueryStyle(catalog, options.topic) : 'kv';
    return applyResolvedUidQuery(query, resolvedUid, style);
  };
  // Match log rows against the post-conversion uid, so evidence correlation
  // uses the same identifier that was sent to LogCenter.
  const privacy = new ClientLogPrivacy(correlation?.identifiers ?? {});
  const safeText = (value: unknown): string => String(privacy.sanitize(value).value);

  const observe = (
    candidate: LogTargetCandidate,
    raw: unknown,
    context: { query: string; start: number; end: number; page: number },
  ): ClientLogObservation => {
    const sanitized = privacy.sanitize(raw);
    const matched = sanitized.matched_identifiers;
    const target = catalog.targets.find((item) => item.id === candidate.target_id);
    const fields: ObservationFields | undefined = target?.observation_fields;
    // H5 埋点的 catalog target 是 platform=h5，但其 UA/rsd 仍携带真实宿主端。
    // 保留 target 的路由语义，同时从观测行补齐源码绑定所需的客户端端信息。
    const rawPlatforms = [...(fields?.platform ?? []), 'ua', 'rsd']
      .flatMap((path) => fieldValues(raw, path))
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .map(String);
    const parsedPlatforms = new Set(rawPlatforms
      .map((value) => parsePlatform(value, fields?.platform_values ?? {}))
      .filter((value): value is 'harmony' | 'android' | 'ios' => value !== null));
    const platformConflict = parsedPlatforms.size > 1;
    const observedPlatform = matched.length > 0 && parsedPlatforms.size === 1
      ? [...parsedPlatforms][0]!
      : 'unknown';
    const timestamp = observationTimestamp(raw);
    const entryId = privacy.entryId({
      target: candidate.target_id,
      timestamp,
      entry: raw,
    });
    const version = matched.length > 0
      ? textField(raw, fields?.version) ?? inferredClientVersion(raw)
      : null;
    const device = textField(raw, fields?.device);
    const session = textField(raw, fields?.session);
    const observationContext = LogObservationContextSchema.parse({
      environment: target?.env ?? 'prod',
      storage_alias: candidate.vendor ?? 'logcenter',
      account: candidate.account ?? 'logcenter',
      collection: candidate.collection ?? candidate.target_id,
      store_id: candidate.store_id ?? candidate.target_id,
      topic: candidate.topic || candidate.target_id,
      appid: candidate.appid ?? candidate.app_clientid ?? candidate.target_id,
      query: safeText(context.query),
      start: context.start,
      end: context.end,
      page: context.page,
      entry_id: entryId,
      redaction_version: CLIENT_LOG_REDACTION_VERSION,
      matched_identifiers: matched,
      matched_error_features: [],
      service_binding: {
        status: matched.length > 0 ? 'confirmed' : 'unconfirmed',
        method: matched.length > 0 ? 'observed_client_session' : null,
      },
      observed_platform: observedPlatform,
      observed_form_factor: inferredClientFormFactor(raw),
      observed_product_line: matched.length > 0
        ? inferredClientProductLine(raw) ?? candidate.product_line
        : null,
      observed_version: version ? safeText(version) : null,
      // 不脱敏（2026-11-13 起内网全链路明文）：设备/会话引用直接保留原始值。
      device_ref: device ? safeText(device) : null,
      session_ref: session ? safeText(session) : null,
      platform_conflict: matched.length > 0 && platformConflict,
    });
    const fieldsValue = sanitized.value;
    const excerpt = typeof fieldsValue === 'string'
      ? fieldsValue.slice(0, 2_000)
      : JSON.stringify(fieldsValue)?.slice(0, 2_000) ?? 'null';
    return {
      entry_id: entryId,
      timestamp: timestamp ? safeText(timestamp) : null,
      excerpt,
      fields: fieldsValue,
      location: `logcenter://${observationContext.environment}/${candidate.store_id ?? candidate.target_id}/${candidate.appid ?? candidate.app_clientid ?? candidate.target_id}#${entryId}`,
      matched_identifiers: matched,
      observation_context: observationContext,
    };
  };

  const observationResult = (
    candidate: LogTargetCandidate,
    rawLogs: unknown[],
    context: { query: string; start: number; end: number; page: number },
    base: Record<string, unknown>,
  ) => {
    const entries = rawLogs.map((raw) => observe(candidate, raw, context));
    const correlated = entries.filter((entry) =>
      entry.observation_context.service_binding.status === 'confirmed'
      && entry.observation_context.matched_identifiers.length > 0,
    );
    return {
      ...base,
      entries,
      observation_status: entries.length === 0 ? 'empty' : correlated.length > 0 ? 'correlated' : 'uncorrelated',
      limitations: entries.length === 0
        ? ['查询为空：只表示已尝试观察，不能确认平台或故障']
        : correlated.length === 0
          ? ['返回条目未匹配当前用户或请求标识，不能作为本次故障的关联观测']
          : [],
    };
  };

  return {
    resolve_log_target: createTool({
      id: 'resolve_log_target',
      description:
        'Resolve a business phrase to a catalog target (SLS appid or logcenter APM). Returns source + suggested_query from config. Prefer exact business/appid aliases. When status=ambiguous and multi_end=true (SLS h5+client same feature), follow strategy h5_first_then_ua—do not pick only one end; requires_uid first. Other ambiguous (e.g. 埋点 vs APM) → clarify once. Routing only; not incident evidence.',
      inputSchema: z.strictObject({ query: z.string().min(1).max(400) }),
      execute: async ({ query }) => {
        const result = resolveLogTarget(catalog, query);
        integrationInfo('logcenter', 'resolve_log_target', {
          query: query.slice(0, 120),
          status: result.status,
          candidateCount: result.candidates.length,
          sources: [...new Set(result.candidates.map((c) => c.source))],
          multiEnd: result.multi_end === true,
        });
        return result;
      },
    }),
    count_cloud_logs: createTool({
      id: 'count_cloud_logs',
      description:
        'Count Aliyun SLS cloud logs for a resolved aliyun_sls target. Prefer after resolve_log_target when source=aliyun_sls. Upstream cloud-count has NO query filter (topic total only). When query/uid is present, Runtime uses cloud-search total instead so filters actually apply. When the round has a resolved learner uid, Runtime ANDs it using query_style from catalog (kv → uid:"…"; fulltext/cloudlearn → "…" phrase). time supports 1h, 昨天, 2026-11-11 07:00到07:40, and YYYY-MM-DD HH:MM:SS~….',
      inputSchema: z.object(SlsTargetFields),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        const query = applyLogUidQuery(input.query, { topic: input.topic });
        // 官方 cloud-count 不接受 query；有过滤条件时改用 search.total，避免「全库量级」误导。
        if (query && query !== '*') {
          const searched = await client.searchCloudLogs({
            vendor: input.vendor,
            region: input.region,
            account: input.account,
            collection: input.collection,
            topic: input.topic,
            start: range.start,
            end: range.end,
            query,
            size: 1,
            from: 0,
          });
          return { total: searched.total, elapsed_ms: searched.elapsed_ms, filtered: true, query };
        }
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
        'Search Aliyun SLS cloud logs for a resolved aliyun_sls target. Prefer catalog suggested_query and query_style. When the round has a resolved learner uid, Runtime ANDs it (kv → uid:"…"; fulltext → "…" phrase—required for prod-cloudlearn). time supports absolute incident windows. Truncated helpers, not ledger evidence.',
      inputSchema: z.object({
        ...SlsTargetFields,
        size: z.number().int().min(1).max(200).default(50),
        from: z.number().int().min(0).default(0),
      }),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        const size = Math.min(input.size ?? 50, 200);
        const query = applyLogUidQuery(input.query?.trim() || '*', { topic: input.topic }) || '*';
        const result = await client.searchCloudLogs({
          vendor: input.vendor,
          region: input.region,
          account: input.account,
          collection: input.collection,
          topic: input.topic,
          start: range.start,
          end: range.end,
          query,
          size,
          from: input.from ?? 0,
        });
        const candidate = candidateForSlsQuery(catalog, input) ?? {
          source: 'aliyun_sls',
          log_kind: 'product_event',
          platform: null,
          client_form: null,
          target_id: input.query?.trim() || `${input.collection}/${input.topic}`,
          store_id: input.collection,
          topic: input.topic,
          vendor: input.vendor,
          region: input.region,
          account: input.account,
          collection: input.collection,
          appid: null,
          business: null,
          service_id: null,
          app_clientid: null,
          product_line: null,
          suggested_query: input.query?.trim() || '*',
          query_style: resolveSlsQueryStyle(catalog, input.topic),
          key_fields: [],
          monitor_types: {},
          notes: [],
        } satisfies LogTargetCandidate;
        return observationResult(candidate, result.logs, {
          query: input.query?.trim() || '*',
          start: range.start,
          end: range.end,
          page: input.from ?? 0,
        }, result);
      },
    }),
    count_logs: createTool({
      id: 'count_logs',
      description:
        'Count 未来云日志中心 logs by service_id for a resolved logcenter/client_apm target. Prefer after resolve_log_target when source=logcenter. When the round has a resolved learner uid, Runtime always AND uid:<id> into the query.',
      inputSchema: z.object(ServiceTargetFields),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        return client.countServiceLogs({
          serviceId: input.service_id,
          start: range.start,
          end: range.end,
          query: applyLogUidQuery(input.query),
        });
      },
    }),
    query_logs: createTool({
      id: 'query_logs',
      description:
        'Query 未来云日志中心 logs by service_id (Lucene). page starts at 1 (not offset). Prefer catalog suggested_query. When the round has a resolved learner uid, Runtime always AND uid:<id> into the query. Truncated helpers, not ledger evidence.',
      inputSchema: z.object({
        ...ServiceTargetFields,
        page: z.number().int().min(1).default(1),
        size: z.number().int().min(1).max(40).default(40),
      }),
      execute: async (input) => {
        const range = parseTimeRangeSeconds(input.time);
        const size = Math.min(input.size ?? 40, 40);
        const result = await client.queryServiceLogs({
          serviceId: input.service_id,
          start: range.start,
          end: range.end,
          query: applyLogUidQuery(input.query),
          page: input.page ?? 1,
          size,
        });
        const candidate = candidateForService(catalog, input.service_id) ?? {
          source: 'logcenter' as const,
          log_kind: 'client_apm' as const,
          platform: null,
          client_form: null,
          target_id: String(input.service_id),
          store_id: null,
          topic: String(input.service_id),
          vendor: null,
          region: null,
          account: null,
          collection: null,
          appid: null,
          business: null,
          service_id: input.service_id,
          app_clientid: null,
          product_line: null,
          suggested_query: input.query?.trim() || '*',
          query_style: 'kv',
          key_fields: [],
          monitor_types: {},
          notes: [],
        } satisfies LogTargetCandidate;
        return observationResult(candidate, result.logs, {
          query: input.query?.trim() || '*',
          start: range.start,
          end: range.end,
          page: input.page ?? 1,
        }, result);
      },
    }),
  };
}
