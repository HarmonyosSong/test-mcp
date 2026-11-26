import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
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
      message: '当前仅支持用学员编号(card，8–20 位纯数字)查询档案',
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
        '按学员编号(card)查询学员档案（uid、姓名、年级等）。用户问“查用户信息/学员信息”且已识别为学员编号时调用；'
        + '仅接受学员编号，不接受 uid。只有 uid 时不要调用本工具，改查 log-mcp 近 3 天登录线索。不返回手机号。',
      inputSchema: z.object({
        learner_id: z.string().min(1).describe('学员编号 card（8–20 位纯数字，如 184010299547；不要传短 uid）'),
      }),
      execute: async (input) => {
        options?.abortSignal?.throwIfAborted();
        return lookupLearnerByCard(client, input.learner_id, options?.abortSignal);
      },
    }),
  };
}
