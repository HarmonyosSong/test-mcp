import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';
import { Hono } from 'hono';
import type { AuthVariables } from '../src/auth/index.js';

import { createConversationRoutes } from '../src/http/conversations.js';
import { ProductStore } from '../src/product/store.js';
import type { DiagnosisAgent, DiagnosisRunInput } from '../src/diagnosis/agent.js';
import type { CapabilityMcp } from '../src/capabilities/mcp.js';
import { RepositoryGitError } from '../src/capabilities/repository.js';
import type { ModelConfiguration } from '../src/model/configuration.js';
import { redactSensitiveText } from '../src/security/redaction.js';
import { InMemoryRunAdmission } from '../src/orchestration/admission.js';

function observabilityOptions(directory: string) {
  return {
    knowledgeQueryLog: join(directory, 'knowledge-queries.jsonl'),
    caseArchiveDir: join(directory, 'knowledge-cases'),
  };
}

test('耗时源码准备前已建立 SSE 并发送 RUN_STARTED', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-stream-start-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let modelStarted = false;
  const routes = createConversationRoutes(store, {
    async *stream() {
      modelStarted = true;
      yield { type: 'completed', text: '已检查', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
    },
  } as unknown as DiagnosisAgent, { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
  { enabled: true } as ModelConfiguration, {
    createConversationSource: async () => { await gate; return { source_limitations: ['组件不可用'] }; },
  });
  try {
    const conversation = await store.createConversation({ title: '慢速源码准备' });
    const response = await routes.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查 iOS 学家云 5.105.0' }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /RUN_STARTED/);
    assert.equal(modelStarted, false);
    release();
    let tail = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      tail += new TextDecoder().decode(chunk.value);
    }
    assert.match(tail, /RUN_FINISHED/);
  } finally {
    release();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
      id, title: 'renamed only', repository_name: null, channel: 'web', message_count: 0,
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

test('Web 新建会话绑定当前登录主体', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-owner-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const routes = createConversationRoutes(store);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('identity', {
      subject: 'teacher-1',
      displayName: 'IT 老师',
      issuer: 'test',
    });
    await next();
  });
  app.route('/', routes);
  try {
    const response = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'owned' }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { id: string };
    assert.equal((await store.getConversation(created.id)).owner_subject, 'teacher-1');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('创建会话拒绝通过 HTTP 预选端、版本或源码绑定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-version-source-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  try {
    const response = await createConversationRoutes(store).request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '精确版本会话',
        platform: 'android',
        product_line: 'xueersi',
        form_factor: 'phone',
        version: '7.106.5',
        build: '55364',
      }),
    });
    assert.equal(response.status, 422);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('空会话的首条提示词会动态绑定对应平台、形态和版本源码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-dynamic-source-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  let sourceInput: Record<string, unknown> | undefined;
  const routes = createConversationRoutes(
    store,
    { async *stream() { yield { type: 'completed', text: '已检查', report: null, evidence_state: {}, messages_state: [], tool_usage: {} }; } } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    {
      createConversationSource: async (input) => {
        sourceInput = input as unknown as Record<string, unknown>;
        return {
          workspace_path: '/snapshots/android-pad',
          repository_id: 'registry-pad',
          repository_name: 'android-pad',
          requested_ref: 'V5.106.5-2225-TEST',
          resolved_commit: 'b'.repeat(40),
          platform: input.platform,
          product_line: input.productLine,
          form_factor: input.formFactor,
          version: input.version,
          build: input.build,
        };
      },
    },
  );
  try {
    const created = await routes.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '动态绑定' }),
    });
    assert.equal(created.status, 201);
    const conversation = await created.json() as { id: string; workspace_path: string | null };
    assert.equal(conversation.workspace_path, null);

    const response = await routes.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '请查 Android 学而思 HD 5.106.5 build 2225 的绘本逻辑' }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(sourceInput?.signal instanceof AbortSignal, true);
    assert.deepEqual({
      platform: 'android',
      productLine: 'xueersi',
      formFactor: 'pad',
      version: '5.106.5',
      build: '2225',
    }, {
      platform: sourceInput?.platform,
      productLine: sourceInput?.productLine,
      formFactor: sourceInput?.formFactor,
      version: sourceInput?.version,
      build: sourceInput?.build,
    });
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.repository_id, 'registry-pad');
    assert.equal(saved.form_factor, 'pad');
    assert.equal(saved.version, '5.106.5');
    assert.equal(saved.build, '2225');
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('源码版本歧义不阻断用户消息，先进入调查并保留可恢复限制', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-source-deferred-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  let diagnosisRuns = 0;
  const routes = createConversationRoutes(
    store,
    {
      async *stream(input: DiagnosisRunInput) {
        diagnosisRuns += 1;
        assert.deepEqual(input.conversation.source_limitations, [
          '源码快照暂未绑定：version_ambiguous: android/latest 命中多个产品线。本轮先查询关联日志，补齐范围后自动重试。',
        ]);
        yield { type: 'completed', text: '已进入日志调查', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true, redact: (value: string) => value } as unknown as ModelConfiguration,
    {
      createConversationSource: async () => {
        throw new RepositoryGitError('version_ambiguous: android/latest 命中多个产品线');
      },
    },
  );
  try {
    const created = await routes.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '先查日志' }),
    });
    assert.equal(created.status, 201);
    const conversation = await created.json() as { id: string };
    const response = await routes.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '请查 Android 学员编号 233021794099 的问题' }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /RUN_FINISHED/);
    assert.equal(diagnosisRuns, 1);
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.workspace_path, null);
    assert.deepEqual(saved.source_limitations, [
      '源码快照暂未绑定：version_ambiguous: android/latest 命中多个产品线。本轮先查询关联日志，补齐范围后自动重试。',
    ]);
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

test('诊断入口会清除不完整的旧工作区字段，避免绕过动态源码绑定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-legacy-source-binding-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  conversation.workspace_path = directory;
  conversation.repository_id = 'legacy-repository';
  conversation.repository_name = 'legacy-app';
  conversation.requested_ref = 'main';
  conversation.resolved_commit = 'a'.repeat(40);
  conversation.source_limitations = ['legacy workspace'];
  await store.saveConversation(conversation);
  const app = createConversationRoutes(
    store,
    { async *stream() { yield { type: 'completed', text: '已完成', report: null, evidence_state: {}, messages_state: [], tool_usage: {} }; } } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
  );
  try {
    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '检查问题' }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.workspace_path, null);
    assert.equal(saved.repository_id, null);
    assert.equal(saved.requested_ref, null);
    assert.deepEqual(saved.source_repositories, []);
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

test('首条用户提示词中的版本上下文会在诊断前绑定源码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-prompt-version-binding-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  let sourceInput: Record<string, unknown> | undefined;
  const app = createConversationRoutes(
    store,
    {
      async *stream() {
        yield { type: 'completed', text: '已完成', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
      },
    } as unknown as DiagnosisAgent,
    {
      createKnowledgeSession: async () => null,
      createRepositorySession: async () => ({
        toolsets: {},
        client: { disconnect: async () => undefined },
      }),
    } as unknown as CapabilityMcp,
    { enabled: true, redact: (value: string) => value } as unknown as ModelConfiguration,
    {
      ...observabilityOptions(directory),
      createConversationSource: async (input) => {
        sourceInput = input as unknown as Record<string, unknown>;
        return {
          workspace_path: directory,
          repository_id: 'repo-android',
          repository_name: 'android-app',
          requested_ref: 'release-7.106.5',
          resolved_commit: 'a'.repeat(40),
          source_repositories: [{
            repository_id: 'repo-android',
            repository_name: 'android-app',
            requested_ref: 'release-7.106.5',
            resolved_commit: 'a'.repeat(40),
            role: 'shell' as const,
            mount_path: '',
          }],
          source_completeness: 'partial' as const,
          source_limitations: ['组件源码未挂载'],
          platform: input.platform,
          product_line: input.productLine,
          form_factor: input.formFactor,
          version: '7.106.5',
          build: '55364',
        };
      },
    },
  );
  try {
    const createdResponse = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(createdResponse.status, 201);
    const conversation = await createdResponse.json() as { id: string; workspace_path: string | null };
    assert.equal(conversation.workspace_path, null);
    assert.equal(sourceInput, undefined);

    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Android 学而思 7.106.5 build 55364 的问题' }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const boundSourceInput = sourceInput as unknown as Record<string, unknown> | undefined;
    assert.equal(boundSourceInput?.platform, 'android');
    assert.equal(boundSourceInput?.productLine, 'xueersi');
    assert.equal(boundSourceInput?.version, '7.106.5');
    assert.equal(boundSourceInput?.build, '55364');
    const saved = await store.getConversation(conversation.id);
    assert.equal(saved.version, '7.106.5');
    assert.equal(saved.source_completeness, 'partial');
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

test('逐字符文本流不脱敏：uid/学员编号与电话均明文保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-stream-privacy-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation();
  const learnerId = 'student-fixture-001';
  const phone = '13800000000';
  const modelText = `已定位学员 ${learnerId}，联系电话 ${phone}，继续检查日志。`;
  const inputText = `学员编号: ${learnerId}; 联系电话: ${phone}; 页面打不开`;
  const diagnosisAgent = {
    async *stream() {
      for (const delta of modelText) yield { type: 'text', delta };
      yield {
        type: 'completed', text: modelText, report: null,
        evidence_state: {}, messages_state: [], tool_usage: {},
      };
    },
  } as unknown as DiagnosisAgent;
  const app = createConversationRoutes(
    store,
    diagnosisAgent,
    {
      createKnowledgeSession: async () => null,
    } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    observabilityOptions(directory),
  );
  try {
    const response = await app.request(`/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: inputText }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const streamedText = [...body.matchAll(/event: TEXT_MESSAGE_CONTENT\ndata: (.+)\n/g)]
      .map((match) => (JSON.parse(match[1]!) as { delta: string }).delta).join('');
    assert.equal(streamedText.includes(learnerId), true);
    assert.equal(streamedText.includes(phone), true);
    assert.match(streamedText, /继续检查日志/);
    const saved = await store.getConversation(conversation.id);
    const assistant = saved.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.content.includes(learnerId), true);
    assert.equal(assistant?.content.includes(phone), true);
    assert.equal(assistant?.status, 'completed');
    const user = saved.messages.find((message) => message.role === 'user');
    assert.equal(user?.content, inputText);
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

test('global admission returns 429 before persisting a message and releases for a later turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-global-admission-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const firstConversation = await store.createConversation();
  const secondConversation = await store.createConversation();
  let releaseRun!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  let runs = 0;
  const diagnosisAgent = {
    async *stream() {
      runs += 1;
      if (runs === 1) {
        markStarted();
        await blocked;
      }
      yield { type: 'completed', text: '完成', report: null, evidence_state: {}, messages_state: [], tool_usage: {} };
    },
  } as unknown as DiagnosisAgent;
  const app = createConversationRoutes(
    store,
    diagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    { ...observabilityOptions(directory), admission: new InMemoryRunAdmission(1) },
  );
  const request = (id: string) => app.request(`/conversations/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '检查问题' }),
  });

  try {
    const first = await request(firstConversation.id);
    assert.equal(first.status, 200);
    await started;
    const rejected = await request(secondConversation.id);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('retry-after'), '1');
    assert.deepEqual(await rejected.json(), { detail: '当前诊断任务较多，请稍后重试', retry_after: 1 });
    assert.equal((await store.getConversation(secondConversation.id)).messages.length, 0);

    releaseRun();
    await first.text();
    const next = await request(secondConversation.id);
    assert.equal(next.status, 200);
    await next.text();
    assert.equal((await store.getConversation(secondConversation.id)).messages.length, 2);
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

test('ai-traces 接口读取落盘 trace 并拒绝路径穿越', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-traces-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const observabilityDir = join(directory, 'observability');
  const { conversationObservabilityDirName } = await import('../src/observability/conversation-span-file-exporter.js');
  try {
    const conversation = await store.createConversation({ title: 'trace 会话' });
    const dir = join(observabilityDir, 'conversations', conversationObservabilityDirName(conversation.id));
    await mkdir(join(dir, 'traces'), { recursive: true });
    const traceId = 'abc123def456';
    await writeFile(
      join(dir, 'manifest.jsonl'),
      `${JSON.stringify({ ts: '2026-11-18T10:00:00Z', trace_id: traceId, message_id: 'm1', file: 'traces/t1.json', summary: { steps: 3, tool_calls: 2 } })}\n`,
    );
    await writeFile(join(dir, 'traces', 't1.json'), JSON.stringify({ trace_id: traceId, user_input: '问题', final_answer: '判定：已定位' }));

    const routes = createConversationRoutes(store, undefined, undefined, undefined, { observabilityDir });
    const list = await routes.request(`/conversations/${conversation.id}/ai-traces`);
    assert.equal(list.status, 200);
    const entries = await list.json() as Array<{ trace_id: string; file?: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.trace_id, traceId);
    assert.equal(entries[0]!.file, undefined);

    const detail = await routes.request(`/conversations/${conversation.id}/ai-traces/${traceId}`);
    assert.equal(detail.status, 200);
    const payload = await detail.json() as { user_input: string };
    assert.equal(payload.user_input, '问题');

    assert.equal((await routes.request(`/conversations/${conversation.id}/ai-traces/..%2F..%2Fetc`)).status, 404);
    assert.equal((await routes.request(`/conversations/${conversation.id}/ai-traces/nope`)).status, 404);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ai-traces 列表合并时间线事件（最新在前），事件详情可单独拉取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-traces-events-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const observabilityDir = join(directory, 'observability');
  const { conversationObservabilityDirName } = await import('../src/observability/conversation-span-file-exporter.js');
  try {
    const conversation = await store.createConversation({ title: '时间线会话' });
    const dir = join(observabilityDir, 'conversations', conversationObservabilityDirName(conversation.id));
    await mkdir(join(dir, 'traces'), { recursive: true });
    await writeFile(
      join(dir, 'manifest.jsonl'),
      `${JSON.stringify({ ts: '2026-11-24T10:08:19Z', trace_id: 'trace-main', message_id: 'm1', file: 'traces/t1.json', summary: { steps: 9, tool_calls: 13 } })}\n`,
    );
    await writeFile(join(dir, 'traces', 't1.json'), JSON.stringify({ trace_id: 'trace-main', user_input: '问题' }));
    const event = {
      event_id: 'evt-settled01',
      kind: 'compass_followup_settled',
      at: '2026-11-24T10:09:12Z',
      title: '服务端协查回执（完成）',
      detail: '下单时少传了一个字段',
      data: { task_id: 'task-1', wait_ms: 37_000 },
    };
    await writeFile(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);

    const routes = createConversationRoutes(store, undefined, undefined, undefined, { observabilityDir });
    const list = await routes.request(`/conversations/${conversation.id}/ai-traces`);
    assert.equal(list.status, 200);
    const entries = await list.json() as Array<Record<string, unknown>>;
    assert.equal(entries.length, 2);
    // 事件比 trace 晚，排最前；且不带 file 字段。
    assert.equal(entries[0]!.trace_id, 'evt-settled01');
    assert.equal(entries[0]!.entry_type, 'event');
    assert.equal(entries[0]!.event_kind, 'compass_followup_settled');
    assert.equal(entries[0]!.title, '服务端协查回执（完成）');
    assert.equal(entries[1]!.trace_id, 'trace-main');
    assert.equal(entries[1]!.entry_type, 'trace');

    const detail = await routes.request(`/conversations/${conversation.id}/ai-traces/evt-settled01`);
    assert.equal(detail.status, 200);
    const payload = await detail.json() as Record<string, unknown>;
    assert.equal(payload.entry_type, 'event');
    assert.equal(payload.kind, 'compass_followup_settled');
    assert.equal(payload.detail, '下单时少传了一个字段');
    assert.deepEqual(payload.data, { task_id: 'task-1', wait_ms: 37_000 });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('web 归档评价：故障终稿可评价、覆盖写、非终稿 422', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-message-feedback-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const routes = createConversationRoutes(store);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('identity', { subject: 'teacher-9', displayName: '归档老师', issuer: 'test' });
    await next();
  });
  app.route('/', routes);
  try {
    const conversation = await store.createConversation({ title: 'web 归档' });
    conversation.messages.push(
      {
        id: 'm-final', role: 'assistant', content: '判定：已定位\n直接原因：token 过期',
        steps: [], status: 'completed', error: null, report: null,
        input_tokens: null, output_tokens: null, context_tokens: null,
        context_cache_read_tokens: null, analysis_feedback: null, tool_usage: {},
        created_at: new Date().toISOString(),
      },
      {
        id: 'm-plain', role: 'assistant', content: '这是普通回复，没有判定标记',
        steps: [], status: 'completed', error: null, report: null,
        input_tokens: null, output_tokens: null, context_tokens: null,
        context_cache_read_tokens: null, analysis_feedback: null, tool_usage: {},
        created_at: new Date().toISOString(),
      },
    );
    await store.saveConversation(conversation);

    // 终稿可评价：写入身份与时间
    const ok = await app.request(`/conversations/${conversation.id}/messages/m-final/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'correct' }),
    });
    assert.equal(ok.status, 200);
    const saved = await store.getConversation(conversation.id);
    const feedback = saved.messages.find((m) => m.id === 'm-final')?.analysis_feedback;
    assert.equal(feedback?.verdict, 'correct');
    assert.equal(feedback?.by_work_code, 'teacher-9');
    assert.equal(feedback?.by_name, '归档老师');
    assert.ok(feedback?.at);

    // 重复评价以最新覆盖（允许点错纠正）
    const again = await app.request(`/conversations/${conversation.id}/messages/m-final/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'failed' }),
    });
    assert.equal(again.status, 200);
    const overwritten = await store.getConversation(conversation.id);
    assert.equal(overwritten.messages.find((m) => m.id === 'm-final')?.analysis_feedback?.verdict, 'failed');

    // 非终稿不可评价
    const plain = await app.request(`/conversations/${conversation.id}/messages/m-plain/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'correct' }),
    });
    assert.equal(plain.status, 422);

    // 消息不存在 / 非法 verdict
    const missing = await app.request(`/conversations/${conversation.id}/messages/nope/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'correct' }),
    });
    assert.equal(missing.status, 404);
    const bad = await app.request(`/conversations/${conversation.id}/messages/m-final/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'great' }),
    });
    assert.equal(bad.status, 422);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
