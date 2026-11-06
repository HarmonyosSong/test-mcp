import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  AuthHttpError,
  authErrorResponse,
  resolveIdentityInput,
  type AuthVariables,
  type IdentityProvider,
  type SSOIdentityProvider,
} from '../auth/index.js';

function allQueryValues(url: string, key: string): string[] {
  const values: string[] = [];
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    if (decodeURIComponent(rawKey.replace(/\+/g, ' ')) === key) {
      values.push(decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    }
  }
  return values;
}

function isSsoProvider(provider: IdentityProvider): provider is SSOIdentityProvider {
  return 'beginLogin' in provider && typeof (provider as SSOIdentityProvider).beginLogin === 'function';
}

function rejectLocalSso(context: Context) {
  return context.json({ detail: 'Local auth mode does not use SSO login' }, 400);
}

export function createAuthRoutes(
  provider: IdentityProvider,
  authMode: 'sso' | 'local',
) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/auth/sso/login', (context) => {
    if (authMode === 'local' || !isSsoProvider(provider)) {
      return rejectLocalSso(context);
    }
    try {
      const returnTo = context.req.query('return_to') ?? undefined;
      const { redirectUrl, binding } = provider.beginLogin(returnTo);
      setCookie(context, provider.stateCookie, binding, provider.stateCookieOptions());
      const headers = provider.privateSessionHeaders();
      for (const [key, value] of Object.entries(headers)) {
        context.header(key, value);
      }
      return context.redirect(redirectUrl, 303);
    } catch (error) {
      return authErrorResponse(error, context);
    }
  });

  app.get('/auth/sso/callback', async (context) => {
    if (authMode === 'local' || !isSsoProvider(provider)) {
      return rejectLocalSso(context);
    }
    try {
      const result = await provider.completeCallback({
        stateValues: allQueryValues(context.req.url, 'state'),
        tokenValues: allQueryValues(context.req.url, 'token'),
        bindingCookie: getCookie(context, provider.stateCookie),
        existingSessionCookie: getCookie(context, provider.cookieName),
      });
      setCookie(
        context,
        provider.cookieName,
        result.sessionToken,
        provider.sessionCookieOptions(),
      );
      deleteCookie(context, provider.stateCookie, {
        path: provider.cookiePath,
        secure: provider.secure,
        httpOnly: true,
        sameSite: 'Lax',
      });
      for (const [key, value] of Object.entries(provider.privateSessionHeaders())) {
        context.header(key, value);
      }
      return context.redirect(result.returnTo, 303);
    } catch (error) {
      return authErrorResponse(error, context);
    }
  });

  app.post('/auth/logout', (context) => {
    if (authMode === 'local' || !isSsoProvider(provider)) {
      return rejectLocalSso(context);
    }
    try {
      const sessionToken = getCookie(context, provider.cookieName);
      provider.resolve(resolveIdentityInput(context, provider));
      provider.store.revoke(sessionToken ?? '');
      deleteCookie(context, provider.cookieName, {
        path: provider.cookiePath,
        secure: provider.secure,
        httpOnly: true,
        sameSite: 'Lax',
      });
      deleteCookie(context, provider.stateCookie, {
        path: provider.cookiePath,
        secure: provider.secure,
        httpOnly: true,
        sameSite: 'Lax',
      });
      for (const [key, value] of Object.entries(provider.privateSessionHeaders())) {
        context.header(key, value);
      }
      return context.json({ logoutUrl: provider.logoutUrl() });
    } catch (error) {
      return authErrorResponse(error, context);
    }
  });

  app.get('/api/session', (context) => {
    try {
      const identity = provider.resolve(resolveIdentityInput(context, provider));
      const csrfToken =
        authMode === 'local' || !isSsoProvider(provider)
          ? ''
          : provider.csrfToken(getCookie(context, provider.cookieName));
      return context.json({
        authMode,
        csrfToken,
        identity: {
          subject: identity.subject,
          displayName: identity.displayName,
          issuer: identity.issuer,
        },
      });
    } catch (error) {
      return authErrorResponse(error, context);
    }
  });

  app.onError((error, context) => {
    if (error instanceof AuthHttpError) return authErrorResponse(error, context);
    throw error;
  });

  return app;
}
