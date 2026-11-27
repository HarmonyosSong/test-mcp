import { APP_PREFIX } from '../auth/paths';

/** Frontend page path relative to APP_PREFIX → /xesapp-agent/usage */
export const USAGE_PAGE_PATH = '/usage';

export function usagePageHref(date?: string): string {
  const base = `${APP_PREFIX}${USAGE_PAGE_PATH}`;
  if (!date) return base;
  return `${base}?date=${encodeURIComponent(date)}`;
}

export function isUsageRoute(pathname: string = window.location.pathname): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const target = `${APP_PREFIX}${USAGE_PAGE_PATH}`.replace(/\/+$/, '');
  return normalized === target;
}

export function navigateToUsage(date?: string): void {
  const href = usagePageHref(date);
  if (`${window.location.pathname}${window.location.search}` === href) return;
  window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function navigateToChat(): void {
  const href = `${APP_PREFIX}/`;
  window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function readUsageDateParam(search: string = window.location.search): string | null {
  const value = new URLSearchParams(search).get('date');
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
