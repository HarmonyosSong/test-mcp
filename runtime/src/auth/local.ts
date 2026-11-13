import { employeeIdentity, type UserIdentity } from './identity.js';
import { AuthHttpError } from './paths.js';
import type { ResolveIdentityInput } from './resolve.js';

export const LOCAL_SUBJECT = '347273';
export const LOCAL_ISSUER = 'local.fixed-workcode';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isLoopbackHost(value: string | null | undefined): boolean {
  if (!value) return false;
  const host = value.trim().toLowerCase();
  if (LOOPBACK.has(host)) return true;
  // Node may report IPv4-mapped IPv6 loopback.
  return host === '::ffff:127.0.0.1';
}

function isAllowedLocalOrigin(origin: string | undefined, configuredBaseUrl: string): boolean {
  if (!origin || origin === configuredBaseUrl) return Boolean(origin);
  try {
    const actual = new URL(origin);
    if (!['http:', 'https:'].includes(actual.protocol) || !isLoopbackHost(actual.hostname)) return false;
    if (!configuredBaseUrl) return true;
    const configured = new URL(configuredBaseUrl);
    const configuredPort = configured.port || (configured.protocol === 'https:' ? '443' : '80');
    const actualPort = actual.port || (actual.protocol === 'https:' ? '443' : '80');
    // Local Vite may be opened as localhost or 127.0.0.1, and HTTP/HTTPS can
    // differ when mkcert is absent. Keep the configured development port.
    return actualPort === configuredPort;
  } catch {
    return false;
  }
}

export class LocalIdentityProvider {
  readonly cookieName = 'xesapp-agent-session';
  readonly publicBaseUrl: string;
  readonly loopbackOnly: boolean;

  constructor(settings: { publicBaseUrl: string; loopbackOnly?: boolean }) {
    this.publicBaseUrl = stripTrailingSlash(settings.publicBaseUrl);
    this.loopbackOnly = settings.loopbackOnly ?? true;
  }

  resolve(input: ResolveIdentityInput): UserIdentity {
    if (this.loopbackOnly) {
      const requestHostname = input.requestHostname ?? '';
      // Hono app.request() has no socket; treat missing client as loopback only when Host is loopback.
      const clientHost =
        input.clientHost && input.clientHost.length > 0
          ? input.clientHost
          : isLoopbackHost(requestHostname)
            ? '127.0.0.1'
            : '';
      if (!isLoopbackHost(clientHost) || !isLoopbackHost(requestHostname)) {
        throw new AuthHttpError(403, 'Local authentication requires loopback access');
      }
    }

    const method = input.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!isAllowedLocalOrigin(input.origin, this.publicBaseUrl)) {
        throw new AuthHttpError(403, 'Invalid local request origin');
      }
    }

    return employeeIdentity(LOCAL_SUBJECT, LOCAL_SUBJECT, LOCAL_ISSUER);
  }
}
