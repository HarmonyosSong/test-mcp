import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRuntimeConfig } from '../src/config.js';
import { createRuntimeApp } from '../src/app.js';
import {
  APP_PREFIX,
  api,
  authedGetHeaders,
  issueSession,
  loadTestConfig,
} from './auth-helpers.js';

test('loads safe defaults and exposes health metadata', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'troubleshoot-odyssey-'));
  try {
    const config = loadTestConfig(dataDir, {
      HARMONY_AGENT_CORS_ORIGINS: 'https://workbench.example.test',
    });
    assert.equal(config.projectRoot, process.cwd().replace(/\/runtime$/, ''));
    assert.equal(config.skillsDir.endsWith('/skills'), true);
    const { app, mastra, modelConfiguration, identityProvider, store } = await createRuntimeApp(config);
    assert.equal((await stat(config.dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(config.dataDir, 'runtime.db'))).mode & 0o777, 0o600);
    const { cookie } = issueSession(identityProvider);
    const secretName = 'RUNTIME_HTTP_AUDIT_SECRET';
    const previousSecret = process.env[secretName];
    const secret = 'http-error-secret-sentinel';
    const originalConsoleError = console.error;
    const logged: string[] = [];
    process.env[secretName] = secret;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    app.get('/api/test-error', () => { throw new Error(`unexpected failure ${secret}`); });
    try {
      const failed = await app.request('/api/test-error');
      assert.equal(failed.status, 500);
      assert.equal(JSON.stringify(await failed.json()).includes(secret), false);
      assert.equal(logged.join(' ').includes(secret), false);
    } finally {
      console.error = originalConsoleError;
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }

    const response = await app.request(api('/health'));
    assert.equal(response.status, 200);
    const health = await response.json() as { status: string; mode: string; model: string | null; provider: string | null };
    assert.equal(health.status, 'ok');
    assert.ok(health.mode === 'demo' || health.mode === 'model');

    const originalStatus = modelConfiguration.status;
    process.env[secretName] = secret;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    modelConfiguration.status = () => { throw new Error(`status failure ${secret}`); };
    try {
      for (const path of [api('/health'), api('/meta')]) {
        const failed = await app.request(path, {
          headers: path.endsWith('/meta') ? authedGetHeaders(cookie) : undefined,
        });
        assert.equal(failed.status, 500, path);
        assert.deepEqual(await failed.json(), { detail: 'Internal Server Error' });
      }
    } finally {
      modelConfiguration.status = originalStatus;
      console.error = originalConsoleError;
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
    assert.equal(logged.join(' ').includes(secret), false);

    const notFound = await app.request(api('/not-a-product-route'), {
      headers: authedGetHeaders(cookie),
    });
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { detail: 'Not Found' });

    for (const path of [
      `${APP_PREFIX}/api/agents`,
      `${APP_PREFIX}/api/workflows`,
      `${APP_PREFIX}/api/tools`,
      `${APP_PREFIX}/api/memory/threads`,
    ]) {
      const response = await app.request(path, { headers: authedGetHeaders(cookie) });
      assert.equal(response.status, 404, `${path} must not expose Mastra's generic server API`);
    }

    const preflight = await app.request(api('/conversations'), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://workbench.example.test',
        'access-control-request-method': 'PATCH',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://workbench.example.test');
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/);

    const metaResponse = await app.request(api('/meta'), {
      headers: authedGetHeaders(cookie),
    });
    assert.equal(metaResponse.status, 200);
    const meta = await metaResponse.json() as {
      mcp_tools: string[];
      constraints: string[];
      context_windows: Record<string, number>;
      model_prices: Record<string, { input: number; output: number }>;
    };
    assert.deepEqual(meta.constraints, ['read-only', 'no-shell', 'no-code-changes', 'no-deveco-cli']);
    assert.deepEqual(meta.mcp_tools, [
      'list_project_files', 'search_project_text', 'read_project_file', 'parse_hilog', 'load_business_context',
    ]);
    assert.equal(meta.context_windows['gpt-5.2'], 400_000);
    assert.deepEqual(meta.model_prices['qwen-plus'], { input: 0.8, output: 4.8 });

    const memory = await mastra.getStorage()?.getStore('memory');
    assert.ok(memory);
    const thread = {
      id: 'foundation-restart-check',
      title: 'persistence check',
      resourceId: 'foundation-test',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await memory.saveThread({ thread });
    await mastra.getStorage()?.close();
    await store.close();

    const restarted = await createRuntimeApp(config);
    const restartedMemory = await restarted.mastra.getStorage()?.getStore('memory');
    assert.equal(
      (await restartedMemory?.getThreadById({ threadId: thread.id }))?.resourceId,
      thread.resourceId,
    );
    await restarted.mastra.getStorage()?.close();
    await restarted.store.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('rejects invalid ports before server startup', () => {
  assert.throws(
    () => loadRuntimeConfig({ HARMONY_MASTRA_PORT: '70000' }),
    /Too big|greater than or equal to 1|maximum/i,
  );
});

test('configured code navigation names remain potential capabilities in metadata', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'troubleshoot-code-index-meta-'));
  const runtime = await createRuntimeApp(loadTestConfig(dataDir, {
    HARMONY_AGENT_CODE_INDEX_COMMAND: '/missing/cbm',
  }));
  try {
    const { cookie } = issueSession(runtime.identityProvider);
    const response = await runtime.app.request(api('/meta'), { headers: authedGetHeaders(cookie) });
    assert.equal(response.status, 200);
    const meta = await response.json() as { mcp_tools: string[] };
    assert.deepEqual(meta.mcp_tools, [
      'list_project_files', 'search_project_text', 'read_project_file', 'parse_hilog', 'load_business_context',
      'search_code_symbols', 'get_code_outline', 'trace_code_path',
    ]);
  } finally {
    await runtime.mastra.getStorage()?.close();
    await runtime.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('loads and validates the global run concurrency limit', () => {
  assert.equal(loadRuntimeConfig({}).maxConcurrentRuns, 4);
  assert.equal(loadRuntimeConfig({ HARMONY_AGENT_MAX_CONCURRENT_RUNS: '2' }).maxConcurrentRuns, 2);
  assert.throws(() => loadRuntimeConfig({ HARMONY_AGENT_MAX_CONCURRENT_RUNS: '0' }));
});

test('A2A 调试提供端默认关闭，只允许本地模式且必须配置本地测试令牌', () => {
  assert.equal(loadRuntimeConfig({}).a2aDebugEnabled, false);
  const enabled = loadRuntimeConfig({
    HARMONY_AGENT_RUN_MODE: 'local',
    HARMONY_AGENT_A2A_DEBUG_ENABLED: 'true',
    HARMONY_AGENT_A2A_TOKEN: 'local-debug-only',
  });
  assert.equal(enabled.a2aDebugEnabled, true);
  assert.throws(() => loadRuntimeConfig({
    HARMONY_AGENT_RUN_MODE: 'server',
    HARMONY_AGENT_A2A_DEBUG_ENABLED: 'true',
    HARMONY_AGENT_A2A_TOKEN: 'local-debug-only',
  }), /RUN_MODE=local/);
  assert.throws(() => loadRuntimeConfig({
    HARMONY_AGENT_RUN_MODE: 'local',
    HARMONY_AGENT_A2A_DEBUG_ENABLED: 'true',
  }), /TOKEN/);
});

test('loads knowledge retrieval and preview strategy settings from environment', () => {
  const config = loadRuntimeConfig({
    HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE: 'v2',
    HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY: 'ranked',
  });
  assert.equal(config.knowledgeRetrievalMode, 'v2');
  assert.equal(config.knowledgePreviewStrategy, 'ranked');
});
