import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  APP_PREFIX,
  PUBLIC_BASE_URL,
  api,
  authedGetHeaders,
  createTestRuntime,
  issueSession,
  writeHeaders,
} from './auth-helpers.js';

test('health is public under app prefix', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      const response = await runtime.app.request(api('/health'));
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { status: string }).status, 'ok');
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('meta requires login', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      const response = await runtime.app.request(api('/meta'));
      assert.equal(response.status, 401);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('session returns identity after cookie', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      const { csrf, cookie } = issueSession(runtime.identityProvider);
      const response = await runtime.app.request(api('/session'), {
        headers: authedGetHeaders(cookie),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        authMode: string;
        csrfToken: string;
        identity: { subject: string; displayName: string };
      };
      assert.equal(body.authMode, 'sso');
      assert.equal(body.csrfToken, csrf);
      assert.equal(body.identity.subject, '080230');
      assert.equal(body.identity.displayName, 'Tester');
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('write without csrf is forbidden', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      const { cookie } = issueSession(runtime.identityProvider);
      const response = await runtime.app.request(api('/conversations'), {
        method: 'POST',
        headers: {
          Origin: PUBLIC_BASE_URL,
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'no-csrf' }),
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

test('write with wrong origin is forbidden', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      const { csrf, cookie } = issueSession(runtime.identityProvider);
      const response = await runtime.app.request(api('/conversations'), {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'X-CSRF-Token': csrf,
          Cookie: cookie,
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

test('write with csrf and origin succeeds', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      const { csrf, cookie } = issueSession(runtime.identityProvider);
      const response = await runtime.app.request(api('/conversations'), {
        method: 'POST',
        headers: writeHeaders(csrf, cookie),
        body: JSON.stringify({ title: 'ok' }),
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json() as { title: string }).title, 'ok');
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('login without sso config returns 503', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir, {
      HARMONY_AGENT_PUBLIC_BASE_URL: '',
      HARMONY_AGENT_SSO_BASE_URL: '',
      HARMONY_AGENT_SSO_APP_ID: '',
      HARMONY_AGENT_SSO_APP_KEY: '',
    });
    try {
      const response = await runtime.app.request(`${APP_PREFIX}/auth/sso/login`, {
        redirect: 'manual',
      });
      assert.equal(response.status, 503);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('paths use app prefix', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sso-auth-'));
  try {
    const runtime = await createTestRuntime(dataDir);
    try {
      assert.equal((await runtime.app.request('/api/health')).status, 404);
      assert.equal((await runtime.app.request(api('/health'))).status, 200);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
