import { apiPath } from '../auth/paths';
import { authenticatedFetch } from '../auth/session-fetch';
import type { UsageStatsResult } from './types';

async function request<T>(path: string): Promise<T> {
  const response = await authenticatedFetch(apiPath(path), {
    headers: { Accept: 'application/json' },
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

/** Backend: GET /xesapp-agent/api/usage/stats */
export function fetchUsageStats(date?: string): Promise<UsageStatsResult> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return request<UsageStatsResult>(`/usage/stats${query}`);
}
