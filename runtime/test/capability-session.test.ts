import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { MCPClient } from '@mastra/mcp';

import { createCapabilitySession, createRoundCapabilitySession } from '../src/capabilities/session.js';
import {
  CapabilityMcp,
  LOG_ROUND_LABEL_HEADER,
  LOG_ROUND_START_HEADER,
  MCP_TOOL_DISCOVERY_TIMEOUT_MS,
  logRoundHeaders,
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

test('round factory mounts learner; knowledge/log 降级时记 unavailable，不暴露 A2A', async () => {
  const provider = new CapabilityMcp(loadRuntimeConfig({
    HARMONY_AGENT_A2A_TOKEN: 'test-a2a-token',
    HARMONY_AGENT_UCENTER_BASE_URL: 'https://ucenter.example.test',
  }));
  provider.createKnowledgeSession = async () => null;
  provider.createLogSession = async () => null;
  const session = await createRoundCapabilitySession(provider, {
    conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1', workspacePath: null,
  });
  try {
    assert.deepEqual(Object.keys(session.toolsets).sort(), ['code_index', 'learner']);
    assert.deepEqual(Object.keys(session.toolsets.code_index!), [
      'list_code_index_scopes',
      'search_code_index',
      'get_code_index_entry',
    ]);
    assert.deepEqual(Object.keys(session.toolsets.learner!), ['lookup_learner']);
    assert.deepEqual(session.unavailable, ['knowledge', 'log']);
  } finally {
    await session.close();
  }
});

test('round factory mounts log toolset when createLogSession succeeds', async () => {
  const provider = new CapabilityMcp(loadRuntimeConfig({
    HARMONY_AGENT_UCENTER_BASE_URL: 'https://ucenter.example.test',
  }));
  provider.createKnowledgeSession = async () => null;
  provider.createCodeIndexSession = async () => null;
  const seenOptions: Array<{ runId?: string; roundStartedAtMs?: number }> = [];
  provider.createLogSession = (async (_conversationId: string, _messageId: string, options: { runId?: string; roundStartedAtMs?: number } = {}) => {
    seenOptions.push(options);
    return {
      client: { disconnect: async () => undefined },
      toolsets: {
        log: {
          search_both_logs: { id: 'search_both_logs', execute: async () => ({ ok: true }) },
          query: { id: 'query', execute: async () => ({ ok: true }) },
        },
      },
    };
  }) as unknown as CapabilityMcp['createLogSession'];
  const roundStartedAtMs = Date.UTC(2026, 10, 19, 7, 50, 20);
  const session = await createRoundCapabilitySession(provider, {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    runId: 'run-1',
    workspacePath: null,
    roundStartedAtMs,
  });
  try {
    assert.ok(session.toolsets.log);
    assert.deepEqual(Object.keys(session.toolsets.log!).sort(), ['query', 'search_both_logs']);
    assert.ok(!session.unavailable.includes('log'));
    // 轮次开始时刻透传到 log-mcp，服务端据此按秒切文件
    assert.deepEqual(seenOptions, [{ runId: 'run-1', roundStartedAtMs }]);
  } finally {
    await session.close();
  }
});

test('log MCP session 使用 HTTP url 与可选 Bearer，发现超时受配置约束', async (context) => {
  const config = loadRuntimeConfig({
    LOG_MCP_URL: 'http://127.0.0.1:8766/mcp',
    LOG_MCP_BEARER_TOKEN: 'tok-test',
    LOG_MCP_CLIENT_TIMEOUT_MS: '45000',
  });
  assert.equal(config.logMcpUrl, 'http://127.0.0.1:8766/mcp');
  assert.equal(config.logMcpBearerToken, 'tok-test');
  assert.equal(config.logMcpTimeoutMs, 45_000);
  assert.equal(
    loadRuntimeConfig({}).logMcpUrl,
    'http://127.0.0.1:8766/mcp',
  );

  const toolsets = { log: { search_both_logs: {} } };
  context.mock.method(MCPClient.prototype, 'listToolsetsWithErrors', async function (this: MCPClient, options: unknown) {
    const configured = this as unknown as {
      defaultTimeout: number;
      serverConfigs: { log: { url: URL; requestInit?: { headers?: Record<string, string> }; timeout: number } };
    };
    assert.equal(configured.defaultTimeout, 45_000);
    assert.equal(configured.serverConfigs.log.timeout, 45_000);
    assert.equal(String(configured.serverConfigs.log.url), 'http://127.0.0.1:8766/mcp');
    assert.equal(configured.serverConfigs.log.requestInit?.headers?.Authorization, 'Bearer tok-test');
    assert.deepEqual(options, { perServerTimeoutMs: MCP_TOOL_DISCOVERY_TIMEOUT_MS });
    return { toolsets, errors: {}, errorDetails: {} };
  });
  const session = await new CapabilityMcp(config).createLogSession('conv-log', 'msg-log');
  try {
    assert.ok(session);
    assert.equal(session!.toolsets, toolsets);
  } finally {
    await session?.client.disconnect();
  }
});

test('log MCP 每轮带 X-Odyssey-Round-Start/Label，供服务端按秒实时切日志', async (context) => {
  const config = loadRuntimeConfig({ LOG_MCP_URL: 'http://127.0.0.1:8766/mcp' });
  const roundStartedAtMs = Date.UTC(2026, 10, 19, 7, 50, 20);
  assert.deepEqual(
    logRoundHeaders({ roundStartedAtMs, conversationId: 'conv-1', messageId: 'msg-1', runId: 'run-1' }),
    {
      [LOG_ROUND_START_HEADER]: String(roundStartedAtMs),
      [LOG_ROUND_LABEL_HEADER]: 'run=run-1 conv=conv-1 msg=msg-1',
    },
  );
  // 无 runId 时标签不出现空段
  assert.equal(
    logRoundHeaders({ roundStartedAtMs, conversationId: 'c', messageId: 'm' })[LOG_ROUND_LABEL_HEADER],
    'conv=c msg=m',
  );

  const toolsets = { log: { search_both_logs: {} } };
  let seenHeaders: Record<string, string> | undefined;
  context.mock.method(MCPClient.prototype, 'listToolsetsWithErrors', async function (this: MCPClient) {
    const configured = this as unknown as {
      serverConfigs: { log: { requestInit?: { headers?: Record<string, string> } } };
    };
    seenHeaders = configured.serverConfigs.log.requestInit?.headers;
    return { toolsets, errors: {}, errorDetails: {} };
  });
  const session = await new CapabilityMcp(config).createLogSession('conv-1', 'msg-1', {
    runId: 'run-1',
    roundStartedAtMs,
  });
  try {
    assert.deepEqual(seenHeaders, {
      [LOG_ROUND_START_HEADER]: String(roundStartedAtMs),
      [LOG_ROUND_LABEL_HEADER]: 'run=run-1 conv=conv-1 msg=msg-1',
    });
  } finally {
    await session?.client.disconnect();
  }
});

test('log MCP 未传轮次时刻时用当前时间兜底，不会漏头', async (context) => {
  const config = loadRuntimeConfig({ LOG_MCP_URL: 'http://127.0.0.1:8766/mcp' });
  let seenHeaders: Record<string, string> | undefined;
  context.mock.method(MCPClient.prototype, 'listToolsetsWithErrors', async function (this: MCPClient) {
    const configured = this as unknown as {
      serverConfigs: { log: { requestInit?: { headers?: Record<string, string> } } };
    };
    seenHeaders = configured.serverConfigs.log.requestInit?.headers;
    return { toolsets: { log: {} }, errors: {}, errorDetails: {} };
  });
  const before = Date.now();
  const session = await new CapabilityMcp(config).createLogSession('conv-x', 'msg-x');
  try {
    const started = Number(seenHeaders?.['X-Odyssey-Round-Start']);
    assert.ok(Number.isFinite(started) && started >= before - 1000);
    assert.equal(seenHeaders?.['X-Odyssey-Round-Label'], 'conv=conv-x msg=msg-x');
  } finally {
    await session?.client.disconnect();
  }
});

test('log MCP 发现失败时返回 null 以降级', async (context) => {
  context.mock.method(MCPClient.prototype, 'listToolsetsWithErrors', async () => ({
    toolsets: {},
    errors: { log: 'ECONNREFUSED' },
    errorDetails: {},
  }));
  const session = await new CapabilityMcp(loadRuntimeConfig({})).createLogSession('conv-x', 'msg-x');
  assert.equal(session, null);
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
