import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';

import type { UserIdentity } from './identity.js';
import { AuthHttpError } from './paths.js';
import type { SSOIdentityProvider } from './sso.js';

export type AuthVariables = {
  identity: UserIdentity;
  identityProvider: SSOIdentityProvider;
};

export function authErrorResponse(error: unknown, context: Context) {
  if (error instanceof AuthHttpError) {
    return context.json({ detail: error.message }, error.status as 400 | 401 | 403 | 502 | 503);
  }
  throw error;
}

export function requireIdentity(provider: SSOIdentityProvider): MiddlewareHandler<{
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
      const identity = provider.resolve({
        method: context.req.method,
        origin: context.req.header('origin'),
        csrfHeader: context.req.header('x-csrf-token'),
        sessionToken: getCookie(context, provider.cookieName),
      });
      context.set('identity', identity);
      context.set('identityProvider', provider);
      await next();
    } catch (error) {
      return authErrorResponse(error, context);
    }
  };
}
