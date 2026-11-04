import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';

import { createConversationRoutes } from '../src/http/conversations.js';
import { ProductNotFoundError, ProductStore } from '../src/product/store.js';
import type { DiagnosisAgent, DiagnosisRunInput } from '../src/diagnosis/agent.js';
import { RepositoryGitError, RepositoryNotFoundError } from '../src/capabilities/repository.js';
import type { CapabilityMcp } from '../src/capabilities/mcp.js';
import type { ModelConfiguration } from '../src/model/configuration.js';
import { redactSensitiveText } from '../src/security/redaction.js';

function observabilityOptions(directory: string) {
  return {
    knowledgeQueryLog: join(directory, 'knowledge-queries.jsonl'),
    caseArchiveDir: join(directory, 'knowledge-cases'),
  };
}

test('conversation routes preserve product DTO and hide runtime-only state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-routes-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const app = createConversationRoutes(store);
  try {
    const created = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'case one' }),
    });
    assert.equal(created.status, 201);
    const conversation = await created.json() as Record<string, unknown>;
    assert.equal(conversation.title, 'case one');
    assert.equal('messages_state' in conversation, false);
    assert.equal('evidence_state' in conversation, false);

    const id = String(conversation.id);
    const updated = await app.request(`/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_override: 'deepseek:deepseek-chat' }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { model_override: string }).model_override, 'deepseek:deepseek-chat');

    const renamed = await app.request(`/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed only' }),
    });
    assert.equal(renamed.status, 200);
    const renamedConversation = await renamed.json() as { title: string; model_override: string };
    assert.equal(renamedConversation.title, 'renamed only');
    assert.equal(renamedConversation.model_override, 'deepseek:deepseek-chat');

    const cleared = await app.request(`/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_override: '' }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as { model_override: string | null }).model_override, null);

    const invalidUpdate = await app.request(`/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(invalidUpdate.status, 422);
    assert.ok(Array.isArray((await invalidUpdate.json() as { detail: unknown }).detail));

    const list = await app.request('/conversations');
    assert.deepEqual(await list.json(), [{
      id, title: 'renamed only', repository_name: null, message_count: 0,
      updated_at: (await store.getConversation(id)).updated_at,
    }]);

    const deleted = await app.request(`/conversations/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');
    const deleteMissing = await app.request(`/conversations/${id}`, { method: 'DELETE' });
    assert.equal(deleteMissing.status, 404);
    assert.deepEqual(await deleteMissing.json(), { detail: 'conversation not found' });
    const missing = await app.request(`/conversations/${id}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { detail: 'conversation not found' });
    const missingUpdate = await app.request(`/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'updated' }),
    });
    assert.equal(missingUpdate.status, 404);
    assert.deepEqual(await missingUpdate.json(), { detail: 'conversation not found' });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('message route reports missing conversations and disabled models with legacy statuses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-routes-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  try {
    const disabledApp = createConversationRoutes(store, {} as DiagnosisAgent, {} as CapabilityMcp, { enabled: false } as ModelConfiguration);
    const disabled = await disabledApp.request('/conversations/any/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    assert.equal(disabled.status, 409);
    assert.deepEqual(await disabled.json(), { detail: '聊天需要先在模型设置中配置模型' });

    for (const body of ['{', JSON.stringify({ content: '' })]) {
      const invalid = await disabledApp.request('/conversations/any/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(invalid.status, 422);
      assert.ok(Array.isArray((await invalid.json() as { detail: unknown }).detail));
    }

    const enabledApp = createConversationRoutes(store, {} as DiagnosisAgent, {} as CapabilityMcp, { enabled: true } as ModelConfiguration);
    const missing = await enabledApp.request('/conversations/missing/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { detail: 'conversation not found' });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries a transient terminal persistence failure before releasing the conversation lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-terminal-retry-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const save = store.saveConversation.bind(store);
  let failTerminalWrite = true;
  store.saveConversation = async (value) => {
    if (failTerminalWrite && value.messages.at(-1)?.status === 'completed') {
      failTerminalWrite = false;
      throw new Error('transient database failure');
    }
    return save(value);
  };
  let runs = 0;
  const diagnosisAgent = {
    async *stream() {
      runs += 1;
      yield { type: 'completed', text: '已完成', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
    },
  } as unknown as DiagnosisAgent;
  const app = createConversationRoutes(
    store,
    diagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );
  const request = () => app.request(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    const first = await request();
    assert.equal(first.status, 200);
    assert.match(await first.text(), /RUN_FINISHED/);
    assert.equal((await store.getConversation(conversation.id)).messages.at(-1)?.status, 'completed');

    const second = await request();
    assert.equal(second.status, 200);
    assert.match(await second.text(), /RUN_FINISHED/);
    assert.equal(runs, 2);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps admission locked after terminal persistence exhausts retries until restart recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-terminal-recovery-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const save = store.saveConversation.bind(store);
  store.saveConversation = async (value) => {
    if (['completed', 'failed'].includes(value.messages.at(-1)?.status ?? '')) {
      throw new Error('database unavailable');
    }
    return save(value);
  };
  const app = createConversationRoutes(
    store,
    {
      async *stream() {
        yield { type: 'completed', text: 'done', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );
  const request = () => app.request(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const first = await request();
      assert.equal(first.status, 200);
      await first.text();
      assert.equal((await store.getConversation(conversation.id)).messages.at(-1)?.status, 'streaming');
      const second = await request();
      assert.equal(second.status, 409);
    } finally {
      console.error = originalError;
    }

    await store.close();
    const recovered = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
    try {
      assert.equal((await recovered.getConversation(conversation.id)).messages.at(-1)?.status, 'failed');
    } finally {
      await recovered.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('releases conversation admission when the initial streaming checkpoint cannot be saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-admission-save-failure-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const saveConversation = store.saveConversation.bind(store);
  let failInitialSave = true;
  store.saveConversation = async (value) => {
    if (failInitialSave) {
      failInitialSave = false;
      throw new Error('injected initial checkpoint failure');
    }
    return saveConversation(value);
  };
  const app = createConversationRoutes(
    store,
    {
      async *stream() {
        yield {
          type: 'completed', text: '已完成', report: null, evidence_state: {}, messages_state: [],
          input_tokens: null, output_tokens: null, tool_usage: {},
        };
      },
    } as unknown as DiagnosisAgent,
    { async createKnowledgeSession() { return null; } } as unknown as CapabilityMcp,
    { enabled: true, redact: (value: string) => value } as unknown as ModelConfiguration,
    observabilityOptions(directory),
  );
  const request = () => app.request(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    assert.equal((await request()).status, 500);
    assert.equal((await store.getConversation(conversation.id)).messages.length, 0);

    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /event: RUN_FINISHED/);
    assert.equal((await store.getConversation(conversation.id)).messages.at(-1)?.status, 'completed');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation creation rejects incompatible workspace and repository bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-routes-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  try {
    const response = await createConversationRoutes(store).request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_path: '/tmp/project', repository_id: 'repo-1' }),
    });
    assert.equal(response.status, 422);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation creation preserves repository-not-found and snapshot failures', async () => {
  const base = { title: 'case', repository_id: 'repo-1', branch: 'missing' };
  const missing = createConversationRoutes({
    async createConversation() { throw new Error('not reached'); },
  } as unknown as ProductStore, undefined, undefined, undefined, {
    async createConversationSource() { throw new ProductNotFoundError('repo-1'); },
  });
  const missingResponse = await missing.request('/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base),
  });
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { detail: 'repository not found' });

  const missingRepository = createConversationRoutes({
    async createConversation() { throw new Error('not reached'); },
  } as unknown as ProductStore, undefined, undefined, undefined, {
    async createConversationSource() { throw new RepositoryNotFoundError('repo-1'); },
  });
  const missingRepositoryResponse = await missingRepository.request('/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base),
  });
  assert.equal(missingRepositoryResponse.status, 404);
  assert.deepEqual(await missingRepositoryResponse.json(), { detail: 'repository not found' });

  const failedSnapshot = createConversationRoutes({} as ProductStore, undefined, undefined, undefined, {
    async createConversationSource() { throw new RepositoryGitError('snapshot unavailable'); },
  });
  const failureResponse = await failedSnapshot.request('/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base),
  });
  assert.equal(failureResponse.status, 422);
  assert.deepEqual(await failureResponse.json(), { detail: 'snapshot unavailable' });
});

test('conversation request parsing returns stable validation errors without echoing submitted values', async () => {
  const routes = createConversationRoutes({} as ProductStore);
  const malformed = await routes.request('/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 422);
  assert.deepEqual((await malformed.json() as { detail: unknown[] }).detail[0], {
    type: 'json_invalid', loc: ['body'], msg: 'invalid JSON body',
  });

  const invalid = await routes.request('/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'case', workspace_path: 'validation-secret-sentinel', repository_id: 'repo-1' }),
  });
  assert.equal(invalid.status, 422);
  const payload = await invalid.json();
  assert.equal(JSON.stringify(payload).includes('validation-secret-sentinel'), false);
});

test('unexpected conversation persistence failures remain server errors', async () => {
  const routes = createConversationRoutes({
    async createConversation() { throw new Error('database unavailable'); },
  } as unknown as ProductStore);
  const response = await routes.request('/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'case one' }),
  });
  assert.equal(response.status, 500);
});

test('unexpected conversation list, read, update, delete, and message-read failures remain server errors', async () => {
  const requests: Array<{ method: string; path: string; headers?: HeadersInit; body?: string; store: Partial<ProductStore> }> = [
    { method: 'GET', path: '/conversations', store: { async listConversations() { throw new Error('storage failure'); } } },
    { method: 'GET', path: '/conversations/conv-1', store: { async getConversation() { throw new Error('storage failure'); } } },
    {
      method: 'PATCH', path: '/conversations/conv-1',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'updated' }),
      store: { async getConversation() { throw new Error('storage failure'); } },
    },
    { method: 'DELETE', path: '/conversations/conv-1', store: { async deleteConversation() { throw new Error('storage failure'); } } },
    {
      method: 'POST', path: '/conversations/conv-1/messages',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '检查问题' }),
      store: { async getConversation() { throw new Error('storage failure'); } },
    },
  ];

  for (const request of requests) {
    const routes = createConversationRoutes(
      request.store as unknown as ProductStore,
      {} as DiagnosisAgent,
      {} as CapabilityMcp,
      { enabled: true } as ModelConfiguration,
    );
    const response = await routes.request(request.path, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    assert.equal(response.status, 500, `${request.method} ${request.path}`);
  }
});

test('conversation stream redacts environment credentials from fallback failures and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-secret-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const variable = 'RUNTIME_AUDIT_ACCESS_TOKEN';
  const previous = process.env[variable];
  const sentinel = 'stream-secret-sentinel-9284';
  process.env[variable] = sentinel;
  const routes = createConversationRoutes(
    store,
    {} as DiagnosisAgent,
    { async createKnowledgeSession() { throw new Error(`upstream Authorization: Bearer ${sentinel}`); } } as unknown as CapabilityMcp,
    { enabled: true, redact: (value: string) => redactSensitiveText(value) } as unknown as ModelConfiguration,
    observabilityOptions(directory),
  );
  try {
    const response = await routes.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.equal(payload.includes(sentinel), false);
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.messages.at(-1)?.error?.includes(sentinel), false);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('message stream persists completion and emits the stable AG-UI terminal sequence once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-stream-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const diagnosisAgent = {
    async *stream() {
      const tool = {
        id: 'tool-1', tool: 'search_project_text', status: 'running', summary: '搜索中',
        arguments_summary: null, result_summary: null, duration_ms: null, created_at: new Date().toISOString(),
      };
      yield { type: 'tool-start', event: tool };
      yield { type: 'tool-end', event: { ...tool, status: 'completed', summary: '搜索完成', duration_ms: 2 }, evidence_state: {} };
      yield { type: 'text', delta: '已检查。' };
      yield {
        type: 'completed', text: '已检查。', report: null,
        evidence_state: {}, messages_state: [{ role: 'user', content: '检查问题' }, { role: 'assistant', content: '已检查。' }],
        input_tokens: 123, output_tokens: 45,
        tool_usage: { attempted: 1, accepted: 1 },
      };
    },
  } as unknown as DiagnosisAgent;
  const capabilities = { createKnowledgeSession: async () => null } as unknown as CapabilityMcp;
  const modelConfiguration = { enabled: true } as ModelConfiguration;
  const app = createConversationRoutes(store, diagnosisAgent, capabilities, modelConfiguration, observabilityOptions(directory));

  try {
    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const stream = await response.text();
    const events = [...stream.matchAll(/event: ([A-Z_]+)/g)].map((match) => match[1]);
    assert.deepEqual(events, [
      'RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
      'STATE_SNAPSHOT', 'RUN_FINISHED',
    ]);
    assert.match(stream, /"status":"running"/);
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.messages.at(-1)?.status, 'completed');
    assert.equal(saved.messages.at(-1)?.content, '已检查。');
    assert.equal(saved.messages.at(-1)?.input_tokens, 123);
    assert.equal(saved.messages.at(-1)?.output_tokens, 45);
    assert.equal(saved.messages.at(-1)?.steps[0]?.status, 'completed');
    assert.deepEqual(saved.messages_state, [
      { role: 'user', content: '检查问题' }, { role: 'assistant', content: '已检查。' },
    ]);
    const cases = await readdir(join(directory, 'knowledge-cases'));
    assert.deepEqual(cases, [`${conversation.id}-${saved.messages.at(-1)?.id}.json`]);
    const queryLog = await readFile(join(directory, 'knowledge-queries.jsonl'), 'utf8');
    assert.match(queryLog, new RegExp(`"conversation_id":"${conversation.id}"`));
    assert.match(queryLog, /"outcome":"completed"/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists tool transitions and evidence before streaming, so restart retains completed observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-checkpoint-'));
  const databaseUrl = `file:${join(directory, 'runtime.db')}`;
  const store = new ProductStore(createClient({ url: databaseUrl }));
  const conversation = await store.createConversation();
  const evidenceState = { version: 1, items: [{ id: 'evidence-1', source: 'tool' }] };
  const app = createConversationRoutes(
    store,
    {
      async *stream(input: DiagnosisRunInput) {
        const tool = {
          id: 'tool-checkpoint', tool: 'read_project_file', status: 'running', summary: '读取中',
          arguments_summary: null, result_summary: null, duration_ms: null, created_at: new Date().toISOString(),
        };
        yield { type: 'tool-start', event: tool };
        yield { type: 'tool-end', event: { ...tool, status: 'completed', summary: '读取完成', result_summary: 'source observation' }, evidence_state: evidenceState };
        await new Promise<void>((resolve) => {
          if (input.abortSignal?.aborted) return resolve();
          input.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'failed', error: 'cancelled', evidence_state: evidenceState, tool_usage: {} };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );

  try {
    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    while (!stream.includes('event: TOOL_CALL_END')) {
      const item = await reader.read();
      assert.equal(item.done, false);
      stream += decoder.decode(item.value);
    }

    const checkpoint = await store.getConversation(conversation.id);
    assert.equal(checkpoint.messages.at(-1)?.steps[0]?.status, 'completed');
    assert.deepEqual(checkpoint.evidence_state, evidenceState);

    const restarted = new ProductStore(createClient({ url: databaseUrl }));
    const recovered = await restarted.getConversation(conversation.id);
    assert.equal(recovered.messages.at(-1)?.status, 'failed');
    assert.equal(recovered.messages.at(-1)?.steps[0]?.status, 'completed');
    assert.deepEqual(recovered.evidence_state, evidenceState);
    await reader.cancel();
    await restarted.close();
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serializes concurrent turns for the same conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-concurrency-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  let releaseRun!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  const diagnosisAgent = {
    async *stream() {
      markStarted();
      await blocked;
      yield { type: 'completed', text: '', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
    },
  } as unknown as DiagnosisAgent;
  const app = createConversationRoutes(
    store,
    diagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );
  const request = () => app.request(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    const first = await request();
    assert.equal(first.status, 200);
    await started;
    const second = await request();
    assert.equal(second.status, 409);
    releaseRun();
    await first.text();
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.messages.filter((message) => message.role === 'user').length, 1);
  } finally {
    releaseRun();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client cancellation preserves partial assistant text and releases the turn lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-cancel-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const app = createConversationRoutes(
    store,
    {
      async *stream(input: DiagnosisRunInput) {
        yield { type: 'text', delta: '半截结论' };
        await new Promise<void>((resolve) => {
          if (input.abortSignal?.aborted) return resolve();
          input.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield {
          type: 'failed', error: 'cancelled', failure_category: 'cancelled', evidence_state: {},
          tool_usage: { attempted: 1 },
        };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );
  const request = () => app.request(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    const response = await request();
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let sawPartialText = false;
    while (!sawPartialText) {
      const item = await reader.read();
      assert.equal(item.done, false);
      sawPartialText = new TextDecoder().decode(item.value).includes('TEXT_MESSAGE_CONTENT');
    }
    await reader.cancel();
    let saved = await store.getConversation(conversation.id);
    for (let attempt = 0; attempt < 20 && saved.messages.at(-1)?.status === 'streaming'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      saved = await store.getConversation(conversation.id);
    }
    assert.equal(saved.messages.at(-1)?.status, 'failed');
    assert.equal(saved.messages.at(-1)?.content, '半截结论');
    assert.equal(saved.messages.at(-1)?.error, '回复中断：请求已取消');
    assert.equal(saved.messages.at(-1)?.tool_usage.failure_category, 'cancelled');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed diagnosis preserves partial assistant text without accepting a report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-failure-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const app = createConversationRoutes(
    store,
    {
      async *stream() {
        yield { type: 'text', delta: '不完整的诊断结论' };
        yield { type: 'failed', error: 'provider failed', failure_category: 'provider_error', evidence_state: {}, tool_usage: {} };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );

  try {
    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    await response.text();
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.messages.at(-1)?.status, 'failed');
    assert.equal(saved.messages.at(-1)?.content, '不完整的诊断结论');
    assert.equal(saved.messages.at(-1)?.error, 'provider failed');
    assert.equal(saved.messages.at(-1)?.report, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external knowledge setup failure closes earlier MCP sessions and releases the conversation turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-setup-failure-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  let knowledgeDisconnects = 0;
  let externalSetupAttempts = 0;
  const app = createConversationRoutes(
    store,
    {
      async *stream() {
        yield {
          type: 'completed', text: '已完成', report: null, evidence_state: {}, messages_state: [],
          input_tokens: null, output_tokens: null, tool_usage: {},
        };
      },
    } as unknown as DiagnosisAgent,
    {
      async createKnowledgeSession() {
        return { client: { async disconnect() { knowledgeDisconnects += 1; } }, toolsets: {} };
      },
      async createExternalKnowledgeTools() {
        externalSetupAttempts += 1;
        if (externalSetupAttempts === 1) throw new Error('external MCP initialization failed');
        return null;
      },
    } as unknown as CapabilityMcp,
    { enabled: true, redact: (value: string) => value } as unknown as ModelConfiguration,
    observabilityOptions(directory),
  );
  const request = () => app.request(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    const failed = await request();
    assert.equal(failed.status, 200);
    const failedStream = await failed.text();
    assert.match(failedStream, /event: RUN_ERROR/);
    assert.match(failedStream, /external MCP initialization failed/);
    assert.equal(knowledgeDisconnects, 1);
    const savedAfterFailure = await store.getConversation(conversation.id);
    assert.equal(savedAfterFailure.messages.at(-1)?.status, 'failed');
    assert.equal(savedAfterFailure.messages.at(-1)?.report, null);

    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /event: RUN_FINISHED/);
    assert.equal(knowledgeDisconnects, 2);
    assert.equal((await store.getConversation(conversation.id)).messages.at(-1)?.status, 'completed');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('first message titles longer than 30 characters end with an ellipsis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-title-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const app = createConversationRoutes(
    store,
    {
      async *stream() {
        yield {
          type: 'completed', text: '已完成', report: null, evidence_state: {}, messages_state: [],
          input_tokens: null, output_tokens: null, tool_usage: {},
        };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true, redact: (value: string) => value } as unknown as ModelConfiguration,
  );
  const content = '123456789012345678901234567890XYZ';
  try {
    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    await response.text();
    assert.equal((await store.getConversation(conversation.id)).title, `${content.slice(0, 30)}…`);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
