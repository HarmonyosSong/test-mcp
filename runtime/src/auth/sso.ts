import { timingSafeEqual } from 'node:crypto';

import { integrationError, integrationInfo, integrationWarn } from '../observability/integration-log.js';
import { employeeIdentity, type UserIdentity } from './identity.js';
import { AuthHttpError, appHome, normalizeAppPrefix, safeReturnTo } from './paths.js';
import type { ResolveIdentityInput } from './resolve.js';
import {
  SESSION_SECONDS,
  STATE_SECONDS,
  SSOSessionStore,
  type StoredSession,
} from './session-store.js';

export interface SsoSettings {
  publicBaseUrl: string;
  appPrefix: string;
  ssoBaseUrl: string;
  ssoAppId: string;
  ssoAppKey: string;
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax';
  path: string;
  maxAge?: number;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export class SSOIdentityProvider {
  readonly appPrefix: string;
  readonly cookiePath = '/';
  readonly cookieName = 'xesapp-agent-session';
  readonly stateCookie = 'xesapp-agent-login';
  readonly store: SSOSessionStore;
  readonly secure: boolean;
  readonly settings: SsoSettings;

  private ticket = '';
  private ticketExpires = 0;
  private ticketLock: Promise<void> = Promise.resolve();

  constructor(
    settings: SsoSettings,
    options: { store?: SSOSessionStore; fetchImpl?: typeof fetch } = {},
  ) {
    this.settings = {
      ...settings,
      publicBaseUrl: stripTrailingSlash(settings.publicBaseUrl),
      ssoBaseUrl: stripTrailingSlash(settings.ssoBaseUrl),
      appPrefix: normalizeAppPrefix(settings.appPrefix),
    };
    this.appPrefix = this.settings.appPrefix;
    this.store = options.store ?? new SSOSessionStore();
    this.secure = this.settings.publicBaseUrl.startsWith('https://');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  get configured(): boolean {
    return Boolean(
      this.settings.publicBaseUrl &&
        this.settings.ssoBaseUrl &&
        this.settings.ssoAppId &&
        this.settings.ssoAppKey,
    );
  }

  requireConfigured(): void {
    if (!this.configured) {
      throw new AuthHttpError(503, 'SSO is not configured');
    }
  }

  sessionCookieOptions(maxAge = SESSION_SECONDS): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
      path: this.cookiePath,
      maxAge,
    };
  }

  stateCookieOptions(): CookieOptions {
    return this.sessionCookieOptions(STATE_SECONDS);
  }

  privateSessionHeaders(): Record<string, string> {
    return {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };
  }

  getSession(sessionToken: string | undefined): StoredSession {
    this.requireConfigured();
    const session = this.store.get(sessionToken ?? '');
    if (!session) throw new AuthHttpError(401, 'Authentication required');
    return session;
  }

  csrfToken(sessionToken: string | undefined): string {
    return this.getSession(sessionToken).csrf;
  }

  resolve(input: ResolveIdentityInput): UserIdentity {
    const session = this.getSession(input.sessionToken);
    const method = input.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = input.csrfHeader ?? '';
      if (
        input.origin !== this.settings.publicBaseUrl ||
        !safeEqual(csrf, session.csrf)
      ) {
        throw new AuthHttpError(403, 'Invalid request origin or CSRF token');
      }
    }
    return session.identity;
  }

  private async getJson(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(this.settings.ssoBaseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    // Never log query values (appkey / token / ticket).
    const logTarget = `${this.settings.ssoBaseUrl}${path}`;
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual' });
      if (!response.ok) {
        integrationWarn('sso', 'upstream HTTP error', { path, status: response.status, url: logTarget });
        throw new Error('bad status');
      }
      const body = (await response.json()) as unknown;
      if (!body || typeof body !== 'object' || typeof (body as { errcode?: unknown }).errcode !== 'number') {
        integrationWarn('sso', 'upstream invalid body', { path, url: logTarget });
        throw new Error('bad body');
      }
      const errcode = (body as { errcode: number }).errcode;
      integrationInfo('sso', 'upstream ok', { path, status: response.status, errcode });
      return body as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof Error && (error.message === 'bad status' || error.message === 'bad body'))) {
        integrationError('sso', 'upstream request failed', error, { path, url: logTarget });
      }
      throw new AuthHttpError(502, 'SSO service unavailable');
    }
  }

  private async getTicket(): Promise<string> {
    let release!: () => void;
    const previous = this.ticketLock;
    this.ticketLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.ticket && this.store.clock() < this.ticketExpires) return this.ticket;
      const body = await this.getJson('/basic/get_ticket', {
        appid: this.settings.ssoAppId,
        appkey: this.settings.ssoAppKey,
      });
      const ticket = body.ticket;
      if (body.errcode !== 0 || typeof ticket !== 'string' || !ticket) {
        throw new AuthHttpError(502, 'SSO service unavailable');
      }
      this.ticket = ticket;
      this.ticketExpires = this.store.clock() + 2 * 60 * 60 - 3 * 60;
      return ticket;
    } finally {
      release();
    }
  }

  beginLogin(returnTo: string | undefined): {
    redirectUrl: string;
    binding: string;
  } {
    this.requireConfigured();
    const target = returnTo || appHome(this.appPrefix);
    const { state, binding } = this.store.issueState(
      safeReturnTo(target, this.appPrefix),
    );
    // Match Python urllib.parse.quote(appid, safe='') + urlencode({"state": state}).
    const redirectUrl =
      `${this.settings.ssoBaseUrl}/portal/login/` +
      `${encodeURIComponent(this.settings.ssoAppId)}?` +
      new URLSearchParams({ state }).toString();
    integrationInfo('sso', 'beginLogin', {
      returnTo: safeReturnTo(target, this.appPrefix),
      ssoHost: this.settings.ssoBaseUrl,
      appIdConfigured: Boolean(this.settings.ssoAppId),
    });
    return { redirectUrl, binding };
  }

  async completeCallback(input: {
    stateValues: string[];
    tokenValues: string[];
    bindingCookie: string | undefined;
    existingSessionCookie: string | undefined;
  }): Promise<{ returnTo: string; sessionToken: string }> {
    this.requireConfigured();
    if (input.stateValues.length !== 1 || input.tokenValues.length !== 1) {
      integrationWarn('sso', 'callback rejected: bad state/token arity', {
        stateCount: input.stateValues.length,
        tokenCount: input.tokenValues.length,
      });
      throw new AuthHttpError(400, 'Invalid login callback');
    }
    const state = input.stateValues[0] ?? '';
    const token = input.tokenValues[0] ?? '';
    if (!state || !token || state.length > 256 || token.length > 8192) {
      integrationWarn('sso', 'callback rejected: invalid state/token shape');
      throw new AuthHttpError(400, 'Invalid login callback');
    }
    const returnTo = this.store.consumeState(state, input.bindingCookie ?? '');
    const body = await this.getJson('/api/v1/sso/verify', {
      token,
      ticket: await this.getTicket(),
    });
    let identity: UserIdentity;
    try {
      const data = body.data;
      if (body.errcode !== 0 || !data || typeof data !== 'object') throw new Error('bad data');
      const record = data as Record<string, unknown>;
      let name = record.name;
      if (name === null || name === undefined) name = '';
      if (typeof name !== 'string') throw new Error('bad name');
      identity = employeeIdentity(String(record.workcode), name, 'sso');
    } catch (error) {
      if (error instanceof AuthHttpError) throw error;
      integrationWarn('sso', 'verify payload rejected', { errcode: body.errcode });
      throw new AuthHttpError(401, 'SSO authentication failed');
    }
    const sessionToken = this.store.create(identity);
    this.store.revoke(input.existingSessionCookie ?? '');
    integrationInfo('sso', 'callback success', {
      subject: identity.subject,
      returnTo,
    });
    return { returnTo, sessionToken };
  }

  logoutUrl(): string {
    const home = appHome(this.appPrefix);
    const path = `${this.settings.publicBaseUrl}${home}?auth=logged-out`;
    return `${this.settings.ssoBaseUrl}/sso/logout?${new URLSearchParams({ path }).toString()}`;
  }
}
