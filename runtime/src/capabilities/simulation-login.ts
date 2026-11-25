import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
import { integrationInfo, integrationWarn } from '../observability/integration-log.js';
import { ApiMcpClient, apiMcpConfigured } from './api-mcp-client.js';
import { recordSimulationLoginToken } from './simulation-login-tokens.js';

export type SimulationLoginStatus =
  | 'ok'
  | 'not_found'
  | 'no_token'
  | 'invalid_request'
  | 'error';

export type SimulationLoginResult = {
  status: SimulationLoginStatus;
  uid?: string;
  token?: string | null;
  message?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** student.resolve 要求的 uid 形态；仅用于 resolve 上游故障时的降级线索。 */
function looksLikeUid(value: string): boolean {
  return /^[0-9]{1,20}$/.test(value);
}

export async function fetchSimulationLoginToken(
  client: ApiMcpClient,
  identifier: string,
): Promise<SimulationLoginResult> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { status: 'invalid_request', message: 'identifier 不能为空' };
  }

  let resolved: Awaited<ReturnType<ApiMcpClient['apiQuery']>>;
  try {
    resolved = await client.apiQuery('student.resolve', { identifier: trimmed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message: `student.resolve 失败：${message}` };
  }

  let uid = '';
  let resolveDegraded = false;
  if (resolved.isError) {
    // fz 上 user-center 的 student.resolve 可能整体 UPSTREAM_ERROR，而 student.get_token 仍可用。
    // 仅当 identifier 已是 uid 形态时降级：仍先走过 resolve，再用 uid 查 Token，并在 message 标明缺口。
    if (resolved.code === 'UPSTREAM_ERROR' && looksLikeUid(trimmed)) {
      uid = trimmed;
      resolveDegraded = true;
    } else {
      return {
        status: 'error',
        message: resolved.message || resolved.code || 'student.resolve 调用失败',
      };
    }
  } else if (resolved.data == null) {
    return {
      status: 'not_found',
      message: '未查到学员，请核实学员编号或 uid',
    };
  } else {
    const student = asRecord(resolved.data);
    uid = typeof student?.uid === 'string' ? student.uid.trim() : '';
    if (!uid) {
      return {
        status: 'error',
        message: '学员已命中但缺少顶层 uid，无法查询模拟登录 Token',
      };
    }
  }

  let tokenResult: Awaited<ReturnType<ApiMcpClient['apiQuery']>>;
  try {
    tokenResult = await client.apiQuery('student.get_token', { uid });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', uid, message: `student.get_token 失败：${message}` };
  }
  if (tokenResult.isError) {
    return {
      status: 'error',
      uid,
      message: tokenResult.message || tokenResult.code || 'student.get_token 调用失败',
    };
  }
  const data = asRecord(tokenResult.data);
  const echoedUid = typeof data?.uid === 'string' ? data.uid.trim() : uid;
  if (echoedUid && echoedUid !== uid) {
    return {
      status: 'error',
      uid,
      message: 'Token 查询返回的 uid 与核实结果不一致',
    };
  }
  const token = data && 'token' in data ? data.token : null;
  if (token == null || (typeof token === 'string' && !token.trim())) {
    return {
      status: 'no_token',
      uid: echoedUid || uid,
      token: null,
      message: resolveDegraded
        ? '身份核实（student.resolve）上游失败后按 uid 降级查询：该学员当前没有模拟登录 Token'
        : '该学员当前没有模拟登录 Token',
    };
  }
  if (typeof token !== 'string') {
    return {
      status: 'error',
      uid: echoedUid || uid,
      message: 'Token 字段类型异常',
    };
  }
  return {
    status: 'ok',
    uid: echoedUid || uid,
    token,
    ...(resolveDegraded
      ? {
          message:
            '身份核实（student.resolve）上游失败，已按 uid 形态降级查询 Token；请人工确认 uid 无误',
        }
      : {}),
  };
}

export type SimulationLoginToolset = {
  get_simulation_login_token: ReturnType<typeof createTool>;
};

export function createSimulationLoginTools(
  config: Pick<RuntimeConfig, 'apiMcpUrl' | 'apiMcpToken'>,
  options: { abortSignal?: AbortSignal; messageId?: string; fetchImpl?: typeof fetch } = {},
): SimulationLoginToolset | null {
  if (!apiMcpConfigured(config)) {
    integrationWarn('api-mcp', 'get_simulation_login_token not mounted: API_MCP_URL/TOKEN missing', {});
    return null;
  }
  const url = config.apiMcpUrl.trim().replace(/\/+$/, '');
  const token = config.apiMcpToken.trim();
  integrationInfo('api-mcp', 'get_simulation_login_token mounted', { url });

  return {
    get_simulation_login_token: createTool({
      id: 'get_simulation_login_token',
      description:
        '查询学员模拟登录 Token。仅当用户明确要求模拟登录/学员登录 Token/扫码登录凭据时调用；'
        + '传入用户原始标识（学员编号或 uid 数字字符串），服务端会先核实身份再查 Token。'
        + '不要把原始 identifier 直接当 uid；不要用于普通排障或仅查档案。',
      inputSchema: z.object({
        identifier: z.string().min(1).describe(
          '用户原始学员标识：学员编号或 uid，保持字符串与前导零',
        ),
      }),
      execute: async (input) => {
        options.abortSignal?.throwIfAborted();
        const client = new ApiMcpClient({
          url,
          token,
          signal: options.abortSignal,
          fetchImpl: options.fetchImpl,
        });
        const result = await fetchSimulationLoginToken(client, input.identifier);
        if (result.status === 'ok' && result.uid && result.token && options.messageId) {
          recordSimulationLoginToken(options.messageId, {
            uid: result.uid,
            token: result.token,
          });
        }
        if (result.status === 'ok') {
          integrationInfo('api-mcp', 'get_simulation_login_token ok', { uid: result.uid });
        } else {
          integrationWarn('api-mcp', 'get_simulation_login_token finished', {
            status: result.status,
            message: result.message,
          });
        }
        return result;
      },
    }),
  };
}
