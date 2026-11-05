import type { RuntimeApp } from '../src/app.js';
import { employeeIdentity, type SSOIdentityProvider } from '../src/auth/index.js';
import { loadRuntimeConfig, type RuntimeConfig } from '../src/config.js';
import { createRuntimeApp } from '../src/app.js';

export const APP_PREFIX = '/xesapp-agent';
export const PUBLIC_BASE_URL = 'http://testserver';

export function api(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const withApi = suffix.startsWith('/api/') || suffix === '/api' ? suffix : `/api${suffix}`;
  return `${APP_PREFIX}${withApi}`;
}

export function testRuntimeEnv(
  dataDir: string,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    HARMONY_MASTRA_DATA_DIR: dataDir,
    HARMONY_AGENT_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    HARMONY_AGENT_APP_PREFIX: APP_PREFIX,
    HARMONY_AGENT_SSO_BASE_URL: 'https://sso.example.com',
    HARMONY_AGENT_SSO_APP_ID: 'test-app',
    HARMONY_AGENT_SSO_APP_KEY: 'test-key',
    HARMONY_AGENT_CORS_ORIGINS: PUBLIC_BASE_URL,
    ...overrides,
  };
}

export function loadTestConfig(
  dataDir: string,
  overrides: Record<string, string | undefined> = {},
): RuntimeConfig {
  return loadRuntimeConfig(testRuntimeEnv(dataDir, overrides));
}

export async function createTestRuntime(
  dataDir: string,
  overrides: Record<string, string | undefined> = {},
): Promise<RuntimeApp> {
  return createRuntimeApp(loadTestConfig(dataDir, overrides));
}

export function issueSession(provider: SSOIdentityProvider): {
  token: string;
  csrf: string;
  cookie: string;
} {
  const token = provider.store.create(employeeIdentity('080230', 'Tester'));
  const session = provider.store.get(token);
  if (!session) throw new Error('failed to create test session');
  return {
    token,
    csrf: session.csrf,
    cookie: `${provider.cookieName}=${token}`,
  };
}

export function writeHeaders(csrf: string, cookie: string): HeadersInit {
  return {
    Origin: PUBLIC_BASE_URL,
    'X-CSRF-Token': csrf,
    Cookie: cookie,
    'Content-Type': 'application/json',
  };
}

export function authedGetHeaders(cookie: string): HeadersInit {
  return { Cookie: cookie };
}
