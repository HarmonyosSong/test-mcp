export { employeeIdentity, type UserIdentity } from './identity.js';
export {
  AuthHttpError,
  DEFAULT_APP_PREFIX,
  appHome,
  normalizeAppPrefix,
  safeReturnTo,
} from './paths.js';
export {
  SESSION_SECONDS,
  STATE_SECONDS,
  SSOSessionStore,
  type StoredSession,
} from './session-store.js';
export { SSOIdentityProvider, type SsoSettings, type CookieOptions } from './sso.js';
export {
  LOCAL_ISSUER,
  LOCAL_SUBJECT,
  LocalIdentityProvider,
} from './local.js';
export type { ResolveIdentityInput } from './resolve.js';
export {
  authErrorResponse,
  requireIdentity,
  resolveIdentityInput,
  type AuthVariables,
  type IdentityProvider,
} from './middleware.js';
