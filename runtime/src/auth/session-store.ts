import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { UserIdentity } from './identity.js';
import { AuthHttpError } from './paths.js';

export const SESSION_SECONDS = 12 * 60 * 60;
export const STATE_SECONDS = 5 * 60;
export const MAX_SESSIONS = 10_000;
export const MAX_STATES = 10_000;

export interface StoredSession {
  identity: UserIdentity;
  expiresAt: number;
  csrf: string;
}

interface StoredState {
  bindingHash: string;
  returnTo: string;
  expiresAt: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Token digests only; absolute expiry; lost on process restart. */
export class SSOSessionStore {
  sessions = new Map<string, StoredSession>();
  states = new Map<string, StoredState>();

  constructor(readonly clock: () => number = () => performance.now() / 1000) {}

  private prune(): void {
    const now = this.clock();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    for (const [key, state] of this.states) {
      if (state.expiresAt <= now) this.states.delete(key);
    }
  }

  issueState(returnTo: string): { state: string; binding: string } {
    this.prune();
    while (this.states.size >= MAX_STATES) {
      const first = this.states.keys().next().value;
      if (first === undefined) break;
      this.states.delete(first);
    }
    const state = tokenUrlSafe();
    const binding = tokenUrlSafe();
    this.states.set(digest(state), {
      bindingHash: digest(binding),
      returnTo,
      expiresAt: this.clock() + STATE_SECONDS,
    });
    return { state, binding };
  }

  consumeState(state: string, binding: string): string {
    this.prune();
    const item = this.states.get(digest(state));
    if (!item || !safeEqual(item.bindingHash, digest(binding))) {
      throw new AuthHttpError(400, 'Login state invalid or expired');
    }
    this.states.delete(digest(state));
    return item.returnTo;
  }

  create(identity: UserIdentity): string {
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new AuthHttpError(503, 'Login temporarily unavailable');
    }
    const token = tokenUrlSafe();
    this.sessions.set(digest(token), {
      identity,
      expiresAt: this.clock() + SESSION_SECONDS,
      csrf: tokenUrlSafe(),
    });
    return token;
  }

  get(token: string): StoredSession | undefined {
    if (!token) return undefined;
    const key = digest(token);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= this.clock()) {
      this.sessions.delete(key);
      return undefined;
    }
    return session;
  }

  revoke(token: string): void {
    if (!token) return;
    this.sessions.delete(digest(token));
  }
}
