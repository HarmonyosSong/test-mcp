import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';

import { createConversationRoutes } from '../src/http/conversations.js';
import { ProductStore } from '../src/product/store.js';
import type { DiagnosisAgent } from '../src/diagnosis/agent.js';
import type { CapabilityMcp } from '../src/capabilities/mcp.js';
import type { ModelConfiguration } from '../src/model/configuration.js';

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

    const list = await app.request('/conversations');
    assert.deepEqual(await list.json(), [{
      id, title: 'case one', repository_name: null, message_count: 0,
      updated_at: (await store.getConversation(id)).updated_at,
    }]);
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

test('message stream persists completion and emits the stable AG-UI terminal sequence once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-stream-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const diagnosisAgent = {
    async *stream() {
      yield { type: 'text', delta: '已检查。' };
      yield {
        type: 'completed', text: '已检查。', report: null,
        evidence_state: {}, messages_state: [{ role: 'user', content: '检查问题' }, { role: 'assistant', content: '已检查。' }],
      };
    },
  } as unknown as DiagnosisAgent;
  const capabilities = { knowledgeToolsets: async () => ({}) } as unknown as CapabilityMcp;
  const modelConfiguration = { enabled: true } as ModelConfiguration;
  const app = createConversationRoutes(store, diagnosisAgent, capabilities, modelConfiguration);

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
      'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
      'STATE_SNAPSHOT', 'RUN_FINISHED',
    ]);
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.messages.at(-1)?.status, 'completed');
    assert.equal(saved.messages.at(-1)?.content, '已检查。');
    assert.deepEqual(saved.messages_state, [
      { role: 'user', content: '检查问题' }, { role: 'assistant', content: '已检查。' },
    ]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
