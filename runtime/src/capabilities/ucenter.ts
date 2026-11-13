import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
import type { ClientIdentity } from '../orchestration/client-identity.js';
import { integrationInfo, integrationWarn } from '../observability/integration-log.js';

export const UCENTER_DEFAULT_BASE_URL = 'https://ucenter-one-inner.speiyou.cn';

export type UcenterUser = {
  uid: string;
  card: string;
  studentId?: string;
  username?: string;
  areaCode?: string;
  gradeName?: string;
};

export type LearnerLookupResult = {
  status: 'ok' | 'not_found' | 'invalid_request' | 'error';
  learner: UcenterUser | null;
  message?: string;
};

export type UcenterClientOptions = {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** 学员编号多为较长纯数字；夹杂字母的 fixture 不做外呼。 */
export function looksLikeLearnerCard(value: string): boolean {
  return /^\d{8,20}$/.test(value.trim());
}

/** SLS KV vs 全文：prod-cloudlearn 等库 appid/uid 未建 KV 索引时必须用 fulltext。 */
export type LogQueryStyle = 'kv' | 'fulltext';

function stripUidClauses(base: string, uid: string, style: LogQueryStyle): string {
  let next = base
    .replace(/\buid\s*:\s*"?[A-Za-z0-9_-]+"?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (style === 'fulltext') {
    const escaped = uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next
      .replace(new RegExp(`"${escaped}"`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return next
    .replace(/^(?:AND\s+)+/i, '')
    .replace(/(?:\s+AND)+$/i, '')
    .trim();
}

/**
 * 日志查询强制带上已解析 uid；若模型误传学员编号当 uid，一律替换。
 * - kv：`uid: "<id>"`（默认，适合已建 KV 索引的库 / APM Lucene）
 * - fulltext：`"<id>"`（对齐 logcenterskill 在 cloudlearn 上的成功路径）
 */
export function applyResolvedUidQuery(
  query: string | undefined,
  uid: string | undefined,
  style: LogQueryStyle = 'kv',
): string | undefined {
  if (!uid) return query?.trim() || undefined;
  const uidClause = style === 'fulltext' ? `"${uid}"` : `uid: "${uid}"`;
  let base = (query ?? '').trim();
  if (!base || base === '*') return uidClause;
  base = stripUidClauses(base, uid, style);
  if (!base || base === '*') return uidClause;
  return `(${base}) AND ${uidClause}`;
}

export class UcenterClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: UcenterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async getUserByCard(card: string, signal?: AbortSignal): Promise<UcenterUser> {
    const trimmed = card.trim();
    const url = new URL('/users/getUserByCard', `${this.baseUrl}/`);
    url.searchParams.set('card', trimmed);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(url, { method: 'GET', signal: requestSignal, redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`ucenter getUserByCard HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      rlt?: boolean;
      message?: string;
      data?: {
        id?: number | string;
        card?: string;
        studentId?: string;
        username?: string;
        areaCode?: string;
        gradeName?: string;
      } | null;
    };
    const data = payload.data;
    if (!data || data.id == null || data.id === '') {
      throw new Error(payload.message?.trim() || 'ucenter 未找到该学员');
    }
    const echoed = typeof data.card === 'string' ? data.card.trim() : '';
    if (echoed && echoed !== trimmed) {
      throw new Error(`ucenter card 回显不一致: expected ${trimmed}, got ${echoed}`);
    }
    return {
      uid: String(data.id),
      card: echoed || trimmed,
      ...(typeof data.studentId === 'string' ? { studentId: data.studentId } : {}),
      ...(typeof data.username === 'string' ? { username: data.username } : {}),
      ...(typeof data.areaCode === 'string' ? { areaCode: data.areaCode } : {}),
      ...(typeof data.gradeName === 'string' ? { gradeName: data.gradeName } : {}),
    };
  }
}

/** card → uid；显式 uid 原样返回；无法转换返回 null（禁止把学员编号当 uid 查日志）。 */
export async function resolveLearnerUid(
  identity: Pick<ClientIdentity, 'learnerId' | 'learnerIdSource'>,
  client: UcenterClient | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const learnerId = identity.learnerId?.trim();
  if (!learnerId) return null;
  if (identity.learnerIdSource === 'uid') return learnerId;
  if (identity.learnerIdSource !== 'card') return null;
  if (!looksLikeLearnerCard(learnerId)) return null;
  if (!client) return null;
  try {
    const user = await client.getUserByCard(learnerId, signal);
    integrationInfo('ucenter', 'card resolved to uid', { card: learnerId, uid: user.uid });
    return user.uid;
  } catch (error) {
    integrationWarn('ucenter', 'card to uid failed', {
      card: learnerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function createUcenterClient(config: {
  ucenterBaseUrl: string;
  ucenterTimeoutMs: number;
}, fetchImpl?: typeof fetch): UcenterClient | null {
  const baseUrl = config.ucenterBaseUrl.trim();
  if (!baseUrl) return null;
  return new UcenterClient({
    baseUrl,
    timeoutMs: config.ucenterTimeoutMs,
    fetchImpl,
  });
}

/** 显式查学员档案（card → UCenter）；不返回手机号等额外 PII。 */
export async function lookupLearnerByCard(
  client: UcenterClient,
  learnerId: string,
  signal?: AbortSignal,
): Promise<LearnerLookupResult> {
  const trimmed = learnerId.trim();
  if (!trimmed) {
    return { status: 'invalid_request', learner: null, message: 'learner_id 不能为空' };
  }
  if (!looksLikeLearnerCard(trimmed)) {
    return {
      status: 'invalid_request',
      learner: null,
      message: '当前仅支持用学员编号(card，8–20 位纯数字)查询档案；日志 uid 请直接用于查日志，不要当档案主键',
    };
  }
  try {
    const learner = await client.getUserByCard(trimmed, signal);
    integrationInfo('ucenter', 'lookup_learner ok', { card: learner.card, uid: learner.uid });
    return { status: 'ok', learner };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    integrationWarn('ucenter', 'lookup_learner failed', { card: trimmed, error: message });
    if (/未找到|not found|空 data|HTTP 404/i.test(message)) {
      return { status: 'not_found', learner: null, message };
    }
    return { status: 'error', learner: null, message };
  }
}

export type LearnerLookupToolset = {
  lookup_learner: ReturnType<typeof createTool>;
};

export function createLearnerLookupTools(
  config: Pick<RuntimeConfig, 'ucenterBaseUrl' | 'ucenterTimeoutMs'>,
  options?: { fetchImpl?: typeof fetch; abortSignal?: AbortSignal },
): LearnerLookupToolset | null {
  const client = createUcenterClient(config, options?.fetchImpl);
  if (!client) {
    integrationWarn('ucenter', 'lookup_learner not mounted: base URL missing', {});
    return null;
  }
  integrationInfo('ucenter', 'lookup_learner mounted', {
    baseUrl: config.ucenterBaseUrl.replace(/\/+$/, ''),
  });
  return {
    lookup_learner: createTool({
      id: 'lookup_learner',
      description:
        '按学员编号(card)查询学员档案（uid、姓名、年级等）。用户问“查用户信息/学员信息”时调用；'
        + '不要用 resolve_log_target。仅接受学员编号，不接受日志 uid。不返回手机号。',
      inputSchema: z.object({
        learner_id: z.string().min(1).describe('学员编号 card（8–20 位纯数字）'),
      }),
      execute: async (input) => {
        options?.abortSignal?.throwIfAborted();
        return lookupLearnerByCard(client, input.learner_id, options?.abortSignal);
      },
    }),
  };
}
