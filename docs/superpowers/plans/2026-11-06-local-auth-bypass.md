# Local Auth Bypass (RUN_MODE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local development skips Zhiyinlou SSO via `HARMONY_AGENT_RUN_MODE=local`; production keeps SSO with default `server`.

**Architecture:** Derive `authMode` from `runMode`. Add `LocalIdentityProvider` (fixed workcode `347273`, loopback + Origin checks). Wire `app.ts` to pick provider. Adjust auth routes, SessionGate, and env docs. Yach IM stays on existing switches.

**Tech Stack:** Hono, Zod config, Node test runner, React SessionGate.

## Global Constraints

- `HARMONY_AGENT_RUN_MODE` default `server`; never auto-infer from NODE_ENV.
- Local subject fixed `347273`, issuer `local.fixed-workcode`.
- Local forces `host=127.0.0.1`; does not force-disable Yach.
- Local `/api/session` returns empty `csrfToken`; SSO routes return `400`.
- Env split: local `.env` → `local`; `.env-prd` → `server`.

## File Map

| File | Responsibility |
|---|---|
| `runtime/src/config.ts` | `runMode`, derived `authMode`, force host on local |
| `runtime/src/auth/local.ts` | `LocalIdentityProvider` |
| `runtime/src/auth/identity.ts` | shared `ResolveIdentityInput` if needed |
| `runtime/src/auth/middleware.ts` | pass client/hostname into `resolve` |
| `runtime/src/auth/index.ts` | exports |
| `runtime/src/http/auth.ts` | local session + reject SSO routes |
| `runtime/src/app.ts` | provider selection; widen `RuntimeApp` type |
| `runtime/test/local-auth.test.ts` | local mode tests |
| `runtime/test/auth-helpers.ts` | allow RUN_MODE override |
| `web/src/auth/SessionGate.tsx` | accept `local` + empty csrf |
| `web/src/App.tsx` | hide logout when local |
| `.env.example`, `.env-prd`, `README.md`, `spec/sso-login-design.md` | docs |

---

### Task 1: Config runMode + authMode

**Files:**
- Modify: `runtime/src/config.ts`
- Modify: `.env.example`, `.env-prd`
- Test: extend via Task 3 HTTP tests (config asserted there)

**Interfaces:**
- Produces: `RuntimeConfig.runMode: 'local' | 'server'`, `RuntimeConfig.authMode: 'local' | 'sso'`, local forces `host: '127.0.0.1'`

- [ ] **Step 1: Add schema fields and derivation**

In `runtimeConfigSchema` add:
```ts
runMode: z.enum(['local', 'server']).default('server'),
```
Parse from `env.HARMONY_AGENT_RUN_MODE`.
In `loadRuntimeConfig` return:
```ts
runMode: config.runMode,
authMode: config.runMode === 'local' ? 'local' : 'sso',
host: config.runMode === 'local' ? '127.0.0.1' : config.host,
```
Update `RuntimeConfig` inferred type accordingly (explicit intersect if zod object does not include derived `authMode`).

- [ ] **Step 2: Env files**

`.env.example`:
```
# local = skip SSO (dev only); server = Zhiyinlou SSO (default / production)
HARMONY_AGENT_RUN_MODE=local
```
`.env-prd`:
```
HARMONY_AGENT_RUN_MODE=server
```

- [ ] **Step 3: Commit**

```bash
git add runtime/src/config.ts .env.example .env-prd
git commit -m "feat: add RUN_MODE for local vs SSO auth"
```

---

### Task 2: LocalIdentityProvider + middleware

**Files:**
- Create: `runtime/src/auth/local.ts`
- Modify: `runtime/src/auth/middleware.ts`, `runtime/src/auth/index.ts`, `runtime/src/auth/sso.ts` (align resolve input)
- Test: `runtime/test/local-auth.test.ts` (unit section)

**Interfaces:**
- Produces:
```ts
export const LOCAL_SUBJECT = '347273';
export type ResolveIdentityInput = {
  method: string;
  origin: string | undefined;
  csrfHeader: string | undefined;
  sessionToken: string | undefined;
  clientHost?: string | null;
  requestHostname?: string | null;
};
export class LocalIdentityProvider {
  readonly cookieName = 'xesapp-agent-session';
  constructor(settings: { publicBaseUrl: string; loopbackOnly?: boolean });
  resolve(input: ResolveIdentityInput): UserIdentity;
}
```
- SSO `resolve` accepts same input shape (extra fields ignored for CSRF path).

- [ ] **Step 1: Write failing unit tests** in `runtime/test/local-auth.test.ts` for resolve success, non-loopback 403, bad origin write 403.

- [ ] **Step 2: Implement `local.ts`** — loopback set `{127.0.0.1,localhost,::1}`; missing clientHost treated as `127.0.0.1` only when requestHostname is loopback (Hono `app.request` has no socket).

- [ ] **Step 3: Middleware** — pass `requestHostname` from URL/Host; `clientHost` from Node `socket.remoteAddress` when present. Export `IdentityProvider = SSOIdentityProvider | LocalIdentityProvider`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add LocalIdentityProvider for RUN_MODE=local"
```

---

### Task 3: Wire app + auth routes + HTTP tests

**Files:**
- Modify: `runtime/src/app.ts`, `runtime/src/http/auth.ts`, `runtime/test/auth-helpers.ts`
- Test: `runtime/test/local-auth.test.ts` (HTTP), keep `sso-auth.test.ts` green

**Interfaces:**
- `createAuthRoutes(provider, authMode)`
- local session JSON as in spec; SSO routes → `400` with detail about local mode

- [ ] **Step 1: Failing HTTP tests** — session without cookie; meta without cookie; login returns 400; wrong-origin POST 403.

- [ ] **Step 2: Implement wiring** in `app.ts` / `http/auth.ts`.

- [ ] **Step 3: Run** `npm --prefix runtime test -- --test-name-pattern='local|session|meta|health'`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: wire local auth mode into runtime HTTP"
```

---

### Task 4: Frontend + docs

**Files:**
- Modify: `web/src/auth/SessionGate.tsx`, `web/src/App.tsx`
- Modify: `README.md`, `spec/sso-login-design.md`

- [ ] **Step 1: SessionGate** — `authMode: 'sso' | 'local'`; valid when `identity.subject` and (`csrfToken` nonempty OR `authMode === 'local'`).

- [ ] **Step 2: App** — `onLogout={session?.authMode === 'sso' ? handleLogout : undefined}`.

- [ ] **Step 3: Docs** — README config row; flip SSO design decision table for 本地免登.

- [ ] **Step 4: Also set developer `.env` `HARMONY_AGENT_RUN_MODE=local` if file exists (do not commit `.env`).

- [ ] **Step 5: Run** `npm --prefix runtime test` and `npm --prefix runtime run typecheck`.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: allow local authMode in web SessionGate"
```

---

## Spec Coverage Check

| Spec item | Task |
|---|---|
| RUN_MODE + derived authMode | 1 |
| Force host 127.0.0.1 | 1 |
| LocalIdentityProvider + loopback/Origin | 2 |
| Provider selection + session/routes | 3 |
| Frontend local + hide logout | 4 |
| Env files / README / SSO design note | 1 + 4 |
| Yach not forced off | (no code change; verified by absence) |
