import { APP_HOME, APP_PREFIX, authPath, withAppPath } from './paths';

export const SESSION_EXPIRED_EVENT = 'session-expired';
export const ACCESS_DENIED_EVENT = 'access-denied';

let csrfToken: string | undefined;
let sessionRequests = new AbortController();

export function setCsrfToken(token?: string) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export function abortSessionRequests() {
  sessionRequests.abort();
  sessionRequests = new AbortController();
}

export function clearSessionClientState() {
  setCsrfToken();
  abortSessionRequests();
}

async function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  notifyAuthFailure = true,
): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const requestedSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = requestedSignal
    ? AbortSignal.any([requestedSignal, sessionRequests.signal])
    : sessionRequests.signal;
  const response = await fetch(input, {
    ...init,
    headers,
    signal,
    credentials: 'same-origin',
  });
  if (signal.aborted) return response;
  if (notifyAuthFailure && response.status === 401) {
    setCsrfToken();
    abortSessionRequests();
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  if (notifyAuthFailure && response.status === 403) {
    window.dispatchEvent(new Event(ACCESS_DENIED_EVENT));
  }
  return response;
}

export const authenticatedFetch: typeof fetch = (input, init) =>
  fetchWithSession(input, init);

export function loginUrl(returnTo: string): string {
  const home = withAppPath('/') || APP_HOME;
  const safePath =
    (returnTo === APP_PREFIX ||
      returnTo.startsWith(`${APP_PREFIX}/`) ||
      returnTo.startsWith(home)) &&
    !returnTo.includes('\\')
      ? returnTo
      : home;
  return `${authPath('/sso/login')}?return_to=${encodeURIComponent(safePath)}`;
}

export async function logout(): Promise<string> {
  const response = await authenticatedFetch(authPath('/logout'), { method: 'POST' });
  if (!response.ok) {
    throw new Error(`退出失败 (${response.status})`);
  }
  const body = (await response.json()) as { logoutUrl?: string };
  if (!body.logoutUrl) {
    throw new Error('退出失败：缺少 logoutUrl');
  }
  clearSessionClientState();
  return body.logoutUrl;
}
