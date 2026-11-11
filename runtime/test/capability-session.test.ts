import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapabilitySession, createRoundCapabilitySession } from '../src/capabilities/session.js';
import { CapabilityMcp } from '../src/capabilities/mcp.js';
import { loadRuntimeConfig } from '../src/config.js';

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
          'resolve_log_target',
          'count_cloud_logs',
          'search_cloud_logs',
          'count_logs',
          'query_logs',
        ]);
      } else {
        assert.deepEqual(session.unavailable, ['knowledge', 'log_catalog']);
      }
    } finally {
      await session.close();
    }
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
