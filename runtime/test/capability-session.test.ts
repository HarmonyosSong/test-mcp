import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { MCPClient } from '@mastra/mcp';

import { createCapabilitySession, createRoundCapabilitySession } from '../src/capabilities/session.js';
import {
  CapabilityMcp,
  MCP_TOOL_DISCOVERY_TIMEOUT_MS,
  repositoryMcpTimeoutMs,
  repositoryServerEnvironment,
} from '../src/capabilities/mcp.js';
import { loadRuntimeConfig } from '../src/config.js';

test('code index 默认关闭但显式传递空 command，配置后总超时覆盖索引、查询和清理宽限', () => {
  const disabled = loadRuntimeConfig({});
  const disabledEnvironment = repositoryServerEnvironment(disabled, '/tmp/runtime-snapshot');
  assert.equal(disabled.codeIndexCommand, '');
  assert.equal(disabled.codeIndexCacheDir, resolve(disabled.projectRoot, '.data/codebase-memory'));
  assert.equal(disabledEnvironment.HARMONY_AGENT_CODE_INDEX_COMMAND, '');
  assert.equal(disabledEnvironment.HARMONY_AGENT_CODE_INDEX_MODE, 'fast');
  assert.equal(disabledEnvironment.HARMONY_AGENT_CODE_INDEX_CACHE, disabled.codeIndexCacheDir);
  assert.equal(disabledEnvironment.HARMONY_AGENT_MCP_WORKSPACE, '/tmp/runtime-snapshot');
  assert.equal(repositoryMcpTimeoutMs(disabled), 30_000);
  assert.equal(repositoryMcpTimeoutMs({ ...disabled, codeIndexCommand: 'cbm' }), 190_000);
  assert.equal(loadRuntimeConfig({ HARMONY_AGENT_CODE_INDEX_COMMAND: '  ' }).codeIndexCommand, '');

  const enabled = loadRuntimeConfig({
    HARMONY_AGENT_CODE_INDEX_COMMAND: 'cbm',
    HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS: '12',
    HARMONY_AGENT_CODE_INDEX_CACHE: '.data/custom-code-index',
  });
  const enabledEnvironment = repositoryServerEnvironment(enabled, '/tmp/runtime-snapshot');
  assert.equal(enabledEnvironment.HARMONY_AGENT_CODE_INDEX_COMMAND, 'cbm');
  assert.equal(enabledEnvironment.HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS, '12');
  assert.equal(enabledEnvironment.HARMONY_AGENT_CODE_INDEX_CACHE, resolve(enabled.projectRoot, '.data/custom-code-index'));
  assert.equal(repositoryMcpTimeoutMs(enabled), 34_000);
  assert.equal(MCP_TOOL_DISCOVERY_TIMEOUT_MS, 15_000);
  assert.throws(() => loadRuntimeConfig({ HARMONY_AGENT_CODE_INDEX_MODE: 'moderate' }));
  assert.throws(() => loadRuntimeConfig({ HARMONY_AGENT_CODE_INDEX_MODE: 'full' }));
  for (const timeout of ['0', '4', '601', '1.5', 'invalid']) {
    assert.throws(() => loadRuntimeConfig({ HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS: timeout }));
  }
});

test('repository session wires both MCP timeouts and explicit environment while discovering within 15s', async (context) => {
  const config = loadRuntimeConfig({ HARMONY_AGENT_CODE_INDEX_COMMAND: 'cbm' });
  const toolsets = { repository: {} };
  context.mock.method(MCPClient.prototype, 'listToolsetsWithErrors', async function (this: MCPClient, options: unknown) {
    // Inspect the options held by the real client without starting a bridge process.
    const configured = this as unknown as {
      defaultTimeout: number;
      serverConfigs: { repository: { timeout: number; env: Record<string, string> } };
    };
    assert.equal(configured.defaultTimeout, 190_000);
    assert.equal(configured.serverConfigs.repository.timeout, 190_000);
    assert.deepEqual(configured.serverConfigs.repository.env, repositoryServerEnvironment(config, '/tmp/runtime-snapshot'));
    assert.deepEqual(options, { perServerTimeoutMs: 15_000 });
    return { toolsets, errors: {}, errorDetails: {} };
  });
  const session = await new CapabilityMcp(config).createRepositorySession('configuration-test', '/tmp/runtime-snapshot');
  try {
    assert.equal(session.toolsets, toolsets);
  } finally {
    await session.client.disconnect();
  }
});

test('capability session mounts optional capabilities and closes in reverse order', async () => {
  const closed: string[] = [];
  const session = await createCapabilitySession([
    {
      id: 'knowledge',
      optional: true,
      async create() {
        return {
          toolsets: { knowledge: { search_knowledge: { id: 'search_knowledge', execute: async () => ({ ok: true }) } } },
          close: async () => { closed.push('knowledge'); },
        };
      },
    },
    {
      id: 'logs',
      optional: true,
      async create() { return null; },
    },
    {
      id: 'repository',
      async create() {
        return {
          toolsets: { repository: { read_project_file: { id: 'read_project_file', execute: async () => ({ ok: true }) } } },
          close: async () => { closed.push('repository'); },
        };
      },
    },
  ], {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    runId: 'run-1',
    workspacePath: null,
  });

  assert.deepEqual(Object.keys(session.toolsets), ['knowledge', 'repository']);
  assert.deepEqual(session.unavailable, ['logs']);
  await session.close();
  await session.close();
  assert.deepEqual(closed, ['repository', 'knowledge']);
});

test('capability session rejects duplicate namespaces and cleans mounted capabilities', async () => {
  let closed = false;
  await assert.rejects(
    () => createCapabilitySession([
      {
        id: 'first',
        async create() {
          return { toolsets: { shared: {} }, close: async () => { closed = true; } };
        },
      },
      {
        id: 'second',
        async create() { return { toolsets: { shared: {} } }; },
      },
    ], {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      runId: 'run-1',
      workspacePath: null,
    }),
    /duplicate capability namespace: shared/,
  );
  assert.equal(closed, true);
});

test('required failure closes earlier clients while optional failures do not abort the round', async () => {
  const closed: string[] = [];
  const registrations = [
    { id: 'optional', optional: true, create: async () => { throw new Error('unavailable'); } },
    { id: 'source', create: async () => ({ toolsets: { source: {} }, close: async () => { closed.push('source'); } }) },
  ];
  const context = { conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null };
  const session = await createCapabilitySession(registrations, context);
  assert.deepEqual(session.unavailable, ['optional']);
  await session.close();
  await assert.rejects(createCapabilitySession([
    ...registrations,
    { id: 'required', create: async () => { throw new Error('source connection failed'); } },
  ], context), /source connection failed/);
  assert.deepEqual(closed, ['source', 'source']);
});

test('cancellation during creation closes acquired clients and skips later factories', async () => {
  const controller = new AbortController();
  let closed = false;
  let nextCalled = false;
  await assert.rejects(createCapabilitySession([
    {
      id: 'first',
      create: async (context) => {
        assert.equal(Object.isFrozen(context), true);
        controller.abort();
        return { toolsets: {}, close: async () => { closed = true; } };
      },
    },
    { id: 'next', create: async () => { nextCalled = true; return { toolsets: {} }; } },
  ], {
    conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null,
    abortSignal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(closed, true);
  assert.equal(nextCalled, false);
});

test('close aborts capability requests and tries every client even when one cleanup fails', async () => {
  let secondClosed = false;
  const session = await createCapabilitySession([
    { id: 'first', create: async () => ({ toolsets: {}, close: async () => { throw new Error('close failed'); } }) },
    { id: 'second', create: async () => ({ toolsets: {}, close: async () => { secondClosed = true; } }) },
  ], { conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null });
  await assert.rejects(session.close(), AggregateError);
  assert.equal(session.context.abortSignal?.aborted, true);
  assert.equal(secondClosed, true);
});

test('round factory keeps unconfigured logs absent and does not expose configured A2A', async () => {
  for (const configured of [false, true]) {
    const provider = new CapabilityMcp(loadRuntimeConfig({
      HARMONY_AGENT_A2A_TOKEN: 'test-a2a-token',
      HARMONY_AGENT_LOGCENTER_APP_ID: configured ? 'test-app' : '',
      HARMONY_AGENT_LOGCENTER_APP_SECRET: configured ? 'test-secret' : '',
      HARMONY_AGENT_LOGCENTER_BASE_URL: 'https://unused.example.test/api',
    }));
    provider.createKnowledgeSession = async () => null;
    const session = await createRoundCapabilitySession(provider, {
      conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null,
    });
    try {
      assert.deepEqual(Object.keys(session.toolsets), configured ? ['log_catalog'] : []);
      if (configured) {
        assert.deepEqual(Object.keys(session.toolsets.log_catalog!), [
          'resolve_log_target', 'count_cloud_logs', 'search_cloud_logs', 'discover_client_sessions',
        ]);
      } else {
        assert.deepEqual(session.unavailable, ['knowledge', 'log_catalog']);
      }
    } finally {
      await session.close();
    }
  }
});

test('日志关联上下文只通过私有 capability 参数透传', async () => {
  const provider = new CapabilityMcp(loadRuntimeConfig({}));
  provider.createKnowledgeSession = async () => null;
  let received: unknown;
  provider.createLogCatalogTools = async (options) => {
    received = options;
    return null;
  };
  const correlation = {
    identifiers: { learner_id: 'student-fixture-001' },
    sourceText: '学员编号: student-fixture-001',
  };
  const session = await createRoundCapabilitySession(provider, {
    conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null,
    logCorrelation: correlation,
  });
  try {
    assert.deepEqual(received, { abortSignal: session.context.abortSignal, correlation });
    assert.equal(JSON.stringify(session.toolsets).includes('student-fixture-001'), false);
  } finally {
    await session.close();
  }
});

test('cancellation in the final unavailable factory cannot return an active session', async () => {
  const controller = new AbortController();
  await assert.rejects(createCapabilitySession([
    { id: 'optional', optional: true, create: async () => { controller.abort(); return null; } },
  ], {
    conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null,
    abortSignal: controller.signal,
  }), { name: 'AbortError' });
});
