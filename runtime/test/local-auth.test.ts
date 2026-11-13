import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AuthHttpError,
  LOCAL_ISSUER,
  LOCAL_SUBJECT,
  LocalIdentityProvider,
} from '../src/auth/index.js';
import { loadRuntimeConfig } from '../src/config.js';
import {
  APP_PREFIX,
  PUBLIC_BASE_URL,
  api,
  createTestRuntime,
  testRuntimeEnv,
} from './auth-helpers.js';

test('runMode local derives authMode and forces loopback host', () => {
  const dataDir = join(tmpdir(), 'local-auth-config');
  const config = loadRuntimeConfig(
    testRuntimeEnv(dataDir, {
      HARMONY_AGENT_RUN_MODE: 'local',
      HARMONY_MASTRA_HOST: '0.0.0.0',
    }),
  );
  assert.equal(config.runMode, 'local');
  assert.equal(config.authMode, 'local');
  assert.equal(config.host, '127.0.0.1');
});

test('runMode default is server SSO', () => {
  const dataDir = join(tmpdir(), 'server-auth-config');
  const config = loadRuntimeConfig(testRuntimeEnv(dataDir, { HARMONY_MASTRA_HOST: '0.0.0.0' }));
  assert.equal(config.runMode, 'server');
  assert.equal(config.authMode, 'sso');
  assert.equal(config.host, '0.0.0.0');
});

test('LocalIdentityProvider returns fixed subject on loopback', () => {
  const provider = new LocalIdentityProvider({ publicBaseUrl: PUBLIC_BASE_URL });
  const identity = provider.resolve({
    method: 'GET',
    origin: undefined,
    csrfHeader: undefined,
    sessionToken: undefined,
    clientHost: '127.0.0.1',
    requestHostname: '127.0.0.1',
  });
  assert.equal(identity.subject, LOCAL_SUBJECT);
  assert.equal(identity.displayName, LOCAL_SUBJECT);
  assert.equal(identity.issuer, LOCAL_ISSUER);
});

test('LocalIdentityProvider rejects non-loopback host', () => {
  const provider = new LocalIdentityProvider({ publicBaseUrl: PUBLIC_BASE_URL });
  assert.throws(
    () =>
      provider.resolve({
        method: 'GET',
        origin: undefined,
        csrfHeader: undefined,
        sessionToken: undefined,
        clientHost: '10.0.0.1',
        requestHostname: '10.0.0.1',
      }),
    (error: unknown) => error instanceof AuthHttpError && error.status === 403,
  );
});

test('LocalIdentityProvider rejects write with wrong origin', () => {
  const provider = new LocalIdentityProvider({ publicBaseUrl: PUBLIC_BASE_URL });
  assert.throws(
    () =>
      provider.resolve({
        method: 'POST',
        origin: 'https://evil.example',
        csrfHeader: undefined,
        sessionToken: undefined,
        clientHost: '127.0.0.1',
        requestHostname: '127.0.0.1',
      }),
    (error: unknown) => error instanceof AuthHttpError && error.status === 403,
  );
});

test('local mode session works without cookie', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir, { HARMONY_AGENT_RUN_MODE: 'local' });
    try {
      const response = await runtime.app.request(`http://127.0.0.1${api('/session')}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        authMode: string;
        csrfToken: string;
        identity: { subject: string; issuer: string };
      };
      assert.equal(body.authMode, 'local');
      assert.equal(body.csrfToken, '');
      assert.equal(body.identity.subject, LOCAL_SUBJECT);
      assert.equal(body.identity.issuer, LOCAL_ISSUER);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local mode meta works without cookie', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir, { HARMONY_AGENT_RUN_MODE: 'local' });
    try {
      const response = await runtime.app.request(`http://127.0.0.1${api('/meta')}`);
      assert.equal(response.status, 200);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local mode rejects SSO login route', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir, { HARMONY_AGENT_RUN_MODE: 'local' });
    try {
      const response = await runtime.app.request(
        `http://127.0.0.1${APP_PREFIX}/auth/sso/login`,
      );
      assert.equal(response.status, 400);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local mode write with wrong origin is forbidden', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir, { HARMONY_AGENT_RUN_MODE: 'local' });
    try {
      const response = await runtime.app.request(`http://127.0.0.1${api('/conversations')}`, {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'bad-origin' }),
      });
      assert.equal(response.status, 403);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local mode write with matching origin succeeds without csrf', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir, { HARMONY_AGENT_RUN_MODE: 'local' });
    try {
      const response = await runtime.app.request(`http://127.0.0.1${api('/conversations')}`, {
        method: 'POST',
        headers: {
          Origin: PUBLIC_BASE_URL,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'local-ok' }),
      });
      assert.equal(response.status, 201);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local mode accepts localhost and 127.0.0.1 on the configured development port', () => {
  const provider = new LocalIdentityProvider({ publicBaseUrl: 'https://127.0.0.1:5174' });
  for (const origin of ['http://127.0.0.1:5174', 'http://localhost:5174', 'https://localhost:5174']) {
    assert.doesNotThrow(() => provider.resolve({
      method: 'POST',
      origin,
      csrfHeader: undefined,
      sessionToken: undefined,
      clientHost: '127.0.0.1',
      requestHostname: '127.0.0.1',
    }));
  }
  assert.throws(() => provider.resolve({
    method: 'POST',
    origin: 'http://localhost:5173',
    csrfHeader: undefined,
    sessionToken: undefined,
    clientHost: '127.0.0.1',
    requestHostname: '127.0.0.1',
  }), /Invalid local request origin/);
});
