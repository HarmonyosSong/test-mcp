import { apiPath } from '../auth/paths';
import { authenticatedFetch } from '../auth/session-fetch';
import type { UsageRangeKey, UsageStatsResult } from './types';

async function request<T>(pathWithQuery: string, signal?: AbortSignal): Promise<T> {
  // pathWithQuery: "/usage/stats?range=7d" — keep query outside apiPath join carefully
  const qIndex = pathWithQuery.indexOf('?');
  const pathOnly = qIndex >= 0 ? pathWithQuery.slice(0, qIndex) : pathWithQuery;
  const query = qIndex >= 0 ? pathWithQuery.slice(qIndex) : '';
  const url = `${apiPath(pathOnly)}${query}`;
  const response = await authenticatedFetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // keep status message
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** Backend: GET /xesapp-agent/api/usage/stats?range=today|yesterday|3d|7d|30d */
export function fetchUsageStats(
  range: UsageRangeKey,
  signal?: AbortSignal,
): Promise<UsageStatsResult> {
  return request<UsageStatsResult>(`/usage/stats?range=${encodeURIComponent(range)}`, signal);
}
