import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  AuthHttpError,
  authErrorResponse,
  type AuthVariables,
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

export function createAuthRoutes(provider: SSOIdentityProvider) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/auth/sso/login', (context) => {
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
    try {
      const sessionToken = getCookie(context, provider.cookieName);
      provider.resolve({
        method: context.req.method,
        origin: context.req.header('origin'),
        csrfHeader: context.req.header('x-csrf-token'),
        sessionToken,
      });
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
      const sessionToken = getCookie(context, provider.cookieName);
      const identity = provider.resolve({
        method: 'GET',
        origin: context.req.header('origin'),
        csrfHeader: context.req.header('x-csrf-token'),
        sessionToken,
      });
      return context.json({
        authMode: 'sso',
        csrfToken: provider.csrfToken(sessionToken),
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
