/** Application path helpers for SSO return_to validation and URL assembly. */

export const DEFAULT_APP_PREFIX = '/xesapp-agent';

export class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthHttpError';
  }
}

export function normalizeAppPrefix(value: string): string {
  let prefix = (value || DEFAULT_APP_PREFIX).trim() || DEFAULT_APP_PREFIX;
  if (!prefix.startsWith('/')) prefix = `/${prefix}`;
  return prefix.replace(/\/+$/, '') || DEFAULT_APP_PREFIX;
}

export function appHome(prefix: string): string {
  return `${normalizeAppPrefix(prefix)}/`;
}

/** Allow only same-app absolute paths under the configured prefix. */
export function safeReturnTo(value: string, appPrefix: string): string {
  const prefix = normalizeAppPrefix(appPrefix);
  let decoded = value;
  for (let i = 0; i < 8; i += 1) {
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      decoded.includes('\\') ||
      [...decoded].some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      decoded.length > 2048
    ) {
      throw new AuthHttpError(400, 'Invalid return path');
    }
    let url: URL;
    try {
      url = new URL(decoded, 'http://invalid.example');
    } catch {
      throw new AuthHttpError(400, 'Invalid return path');
    }
    if (url.host !== 'invalid.example' || url.protocol !== 'http:') {
      throw new AuthHttpError(400, 'Invalid return path');
    }
    const nextValue = decodeURIComponent(decoded);
    if (nextValue === decoded) break;
    decoded = nextValue;
  }
  if (decoded !== value) {
    // Final pass already validated; ensure path still under prefix after decode loops.
  }
  let path: string;
  try {
    path = new URL(decoded, 'http://invalid.example').pathname;
  } catch {
    throw new AuthHttpError(400, 'Invalid return path');
  }
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw new AuthHttpError(400, 'Invalid return path');
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new AuthHttpError(400, 'Invalid return path');
  }
  return value;
}
