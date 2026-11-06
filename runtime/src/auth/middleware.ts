import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';

import type { UserIdentity } from './identity.js';
import type { LocalIdentityProvider } from './local.js';
import { AuthHttpError } from './paths.js';
import type { ResolveIdentityInput } from './resolve.js';
import type { SSOIdentityProvider } from './sso.js';

export type IdentityProvider = SSOIdentityProvider | LocalIdentityProvider;

export type AuthVariables = {
  identity: UserIdentity;
  identityProvider: IdentityProvider;
};

export function authErrorResponse(error: unknown, context: Context) {
  if (error instanceof AuthHttpError) {
    return context.json({ detail: error.message }, error.status as 400 | 401 | 403 | 502 | 503);
  }
  throw error;
}

function requestHostname(context: Context): string | undefined {
  try {
    return new URL(context.req.url).hostname;
  } catch {
    const host = context.req.header('host');
    if (!host) return undefined;
    return host.replace(/:\d+$/, '');
  }
}

function clientHost(context: Context): string | undefined {
  const raw = context.req.raw as { socket?: { remoteAddress?: string } } | undefined;
  const address = raw?.socket?.remoteAddress;
  return address || undefined;
}

export function resolveIdentityInput(
  context: Context,
  provider: IdentityProvider,
): ResolveIdentityInput {
  return {
    method: context.req.method,
    origin: context.req.header('origin'),
    csrfHeader: context.req.header('x-csrf-token'),
    sessionToken: getCookie(context, provider.cookieName),
    clientHost: clientHost(context),
    requestHostname: requestHostname(context),
  };
}

export function requireIdentity(provider: IdentityProvider): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (context, next: Next) => {
    const path = context.req.path;
    // Health is public. /api/session authenticates inside its own handler.
    // Paths may include the app prefix depending on mount style.
    if (
      path === '/api/health' ||
      path.endsWith('/api/health') ||
      path === '/api/session' ||
      path.endsWith('/api/session')
    ) {
      await next();
      return;
    }
    try {
      const identity = provider.resolve(resolveIdentityInput(context, provider));
      context.set('identity', identity);
      context.set('identityProvider', provider);
      await next();
    } catch (error) {
      return authErrorResponse(error, context);
    }
  };
}
