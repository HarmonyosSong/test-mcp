const configuredBase = (import.meta.env.BASE_URL || '/xesapp-agent/').replace(/\/?$/, '/');

/** Application home path with trailing slash, e.g. `/xesapp-agent/`. */
export const APP_HOME = configuredBase.startsWith('/') ? configuredBase : `/${configuredBase}`;

/** Prefix without trailing slash, e.g. `/xesapp-agent`. */
export const APP_PREFIX = APP_HOME.replace(/\/$/, '') || '/xesapp-agent';

export function apiPath(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${APP_PREFIX}${suffix.startsWith('/api') ? suffix : `/api${suffix}`}`;
}

export function authPath(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${APP_PREFIX}/auth${suffix}`;
}

export function withAppPath(path: string): string {
  if (!path.startsWith('/')) return `${APP_HOME}${path}`;
  if (path === APP_PREFIX || path.startsWith(`${APP_PREFIX}/`)) return path;
  return `${APP_PREFIX}${path}`;
}
