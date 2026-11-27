import { APP_PREFIX } from '../auth/paths';
import type { UsageRangeKey } from './types';

/** Frontend page path relative to APP_PREFIX → /xesapp-agent/usage */
export const USAGE_PAGE_PATH = '/usage';

const RANGE_KEYS: UsageRangeKey[] = ['today', 'yesterday', '3d', '7d', '30d'];

export function usagePageHref(range?: UsageRangeKey): string {
  const base = `${APP_PREFIX}${USAGE_PAGE_PATH}`;
  if (!range || range === 'yesterday') return base;
  return `${base}?range=${encodeURIComponent(range)}`;
}

export function isUsageRoute(pathname: string = window.location.pathname): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const target = `${APP_PREFIX}${USAGE_PAGE_PATH}`.replace(/\/+$/, '');
  return normalized === target;
}

export function navigateToUsage(range?: UsageRangeKey): void {
  const href = usagePageHref(range);
  if (`${window.location.pathname}${window.location.search}` === href) return;
  window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function navigateToChat(): void {
  const href = `${APP_PREFIX}/`;
  window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function readUsageRangeParam(search: string = window.location.search): UsageRangeKey {
  const value = new URLSearchParams(search).get('range');
  if (value && RANGE_KEYS.includes(value as UsageRangeKey)) return value as UsageRangeKey;
  return 'yesterday';
}
