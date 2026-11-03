import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ModelConfiguration, ModelConfigurationError, transformRelaxedRequestBody } from '../src/model/configuration.js';

async function withConfig(
  run: (config: ModelConfiguration, filePath: string, directory: string) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-model-config-'));
  const filePath = join(directory, 'model-config.json');
  try {
    await run(new ModelConfiguration({ filePath, env }), filePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('exposes the legacy provider presets without network access', async () => {
  await withConfig(async (configuration) => {
    const presets = configuration.providers();
    assert.deepEqual(presets.map(({ id }) => id), [
      'openai', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'doubao', 'custom',
    ]);
    assert.equal(presets.find(({ id }) => id === 'qwen')?.api_key_env, 'DASHSCOPE_API_KEY');
    assert.equal(presets.find(({ id }) => id === 'custom')?.requires_api_key, false);
    assert.deepEqual(configuration.status(), {
      mode: 'demo',
      configured: false,
      provider: null,
      provider_name: null,
      model_name: null,
      base_url: null,
      api_key_configured: false,
      source: null,
      compatibility_mode: 'standard',
    });
  });
});

test('persists credentials with 0600 permissions and restores them without exposing them', async () => {
  await withConfig(async (configuration, filePath) => {
    const secret = 'deepseek-secret-value';
    const status = await configuration.configure({
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: secret,
    });
    assert.equal(status.source, 'runtime');
    assert.equal(status.api_key_configured, true);
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).api_key, secret);

    const restarted = new ModelConfiguration({ filePath, env: {} });
    await restarted.initialize();
    const restoredStatus = restarted.status();
    assert.equal(restoredStatus.source, 'persisted');
    assert.equal(restoredStatus.model_name, 'deepseek-chat');
    assert.equal(restoredStatus.api_key_configured, true);
    assert.equal(JSON.stringify(restoredStatus).includes(secret), false);
    assert.deepEqual(await restarted.configuredDiscovery(), {
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key: secret,
    });
  });
});

test('environment model configuration takes precedence over persisted configuration', async () => {
  await withConfig(async (_configuration, filePath) => {
    const writer = new ModelConfiguration({ filePath, env: {} });
    await writer.configure({
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'persisted-secret',
    });

    const environment = new ModelConfiguration({
      filePath,
      env: {
        HARMONY_AGENT_MODE: 'model',
        HARMONY_AGENT_MODEL: 'openai:gpt-5-mini',
        OPENAI_API_KEY: 'environment-secret',
      },
    });
    await environment.initialize();
    assert.equal(environment.status().source, 'environment');
    assert.equal(environment.status().provider, 'openai');
    assert.equal(environment.status().model_name, 'gpt-5-mini');
    assert.equal(environment.status().api_key_configured, true);
  });
});

test('builds a Mastra OpenAI-compatible chat model config with the selected endpoint and secret', async () => {
  await withConfig(async (configuration) => {
    await configuration.configure({
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'model-secret',
    });
    const model = await configuration.languageModel();
    assert.equal(model.modelId, 'deepseek-chat');
    assert.equal(model.provider, 'deepseek.chat');
    assert.equal((model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs, true);
  });
});

test('relaxed compatibility transforms schemas and request fields for older chat endpoints', () => {
  const transformed = transformRelaxedRequestBody({
    max_completion_tokens: 100,
    messages: [
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'user', content: 'hello' },
    ],
    tools: [{ type: 'function', function: {
      name: 'demo', strict: true,
      parameters: { type: 'object', $defs: { Item: { type: 'string' } }, properties: { item: { $ref: '#/$defs/Item' } } },
    } }],
  });
  assert.equal(transformed.max_tokens, 100);
  assert.equal(transformed.max_completion_tokens, undefined);
  assert.deepEqual(transformed.messages, [
    { role: 'system', content: 'one\n\ntwo' },
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(transformed.tools, [{ type: 'function', function: {
    name: 'demo', parameters: { type: 'object', properties: { item: { type: 'string' } } },
  } }]);
});

test('relaxed mode creates a Mastra-compatible model with structured output disabled', async () => {
  await withConfig(async (configuration) => {
    await configuration.configure({
      provider: 'custom', model_name: 'local-model', base_url: 'http://127.0.0.1:11434/v1',
      no_api_key: true, compatibility_mode: 'relaxed',
    });
    const model = await configuration.languageModel();
    assert.equal(model.modelId, 'local-model');
    assert.equal((model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs, false);
  });
});

test('configure uses request key, then matching active key, then provider environment key', async () => {
  await withConfig(async (configuration, filePath) => {
    const envKey = 'environment-qwen-secret';
    const withEnv = new ModelConfiguration({
      filePath,
      env: { DASHSCOPE_API_KEY: envKey },
    });
    const first = await withEnv.configure({ provider: 'qwen', model_name: 'qwen-plus' });
    assert.equal(first.api_key_configured, true);
    assert.equal((await withEnv.configuredDiscovery()).api_key, envKey);

    await configuration.configure({
      provider: 'qwen', model_name: 'qwen-plus', api_key: 'runtime-secret',
    });
    const reused = await configuration.configure({ provider: 'qwen', model_name: 'qwen-max' });
    assert.equal(reused.api_key_configured, true);
    const replaced = await configuration.configure({
      provider: 'qwen', model_name: 'qwen-turbo', api_key: 'request-secret',
    });
    assert.equal(replaced.api_key_configured, true);
    assert.equal((await configuration.configuredDiscovery()).api_key, 'request-secret');
  });
});

test('requires provider credentials unless explicitly disabled and supports local custom endpoints', async () => {
  await withConfig(async (configuration) => {
    await assert.rejects(
      configuration.configure({ provider: 'deepseek', model_name: 'deepseek-chat' }),
      ModelConfigurationError,
    );
    const status = await configuration.configure({
      provider: 'custom',
      model_name: 'qwen-local',
      base_url: 'http://127.0.0.1:11434/v1/',
      no_api_key: true,
      compatibility_mode: 'relaxed',
    });
    assert.equal(status.base_url, 'http://127.0.0.1:11434/v1');
    assert.equal(status.api_key_configured, false);
    assert.equal(status.compatibility_mode, 'relaxed');
    assert.deepEqual(await configuration.configuredDiscovery(), {
      provider: 'custom',
      base_url: 'http://127.0.0.1:11434/v1',
      api_key: null,
    });
  });
});

test('discovery credential precedence is request, matching active config, then environment', async () => {
  await withConfig(async (configuration) => {
    const configured = await configuration.configure({
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'active-secret',
    });
    assert.equal(configured.configured, true);
    assert.equal((await configuration.resolveDiscovery({ provider: 'deepseek' })).api_key, 'active-secret');
    assert.equal(
      (await configuration.resolveDiscovery({ provider: 'deepseek', api_key: 'request-secret' })).api_key,
      'request-secret',
    );
    assert.equal(
      (await configuration.resolveDiscovery({
        provider: 'deepseek', base_url: 'https://other.example/v1', api_key: 'request-secret',
      })).base_url,
      'https://other.example/v1',
    );
    assert.equal(
      (await configuration.resolveDiscovery({ provider: 'deepseek', no_api_key: true })).api_key,
      null,
    );
  });
});

test('disable removes persisted configuration and returns demo status', async () => {
  await withConfig(async (configuration, filePath) => {
    await configuration.configure({
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'remove-me',
    });
    assert.equal((await stat(filePath)).isFile(), true);
    assert.equal((await configuration.disable()).configured, false);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });

    const restarted = new ModelConfiguration({ filePath, env: {} });
    await restarted.initialize();
    assert.equal(restarted.status().configured, false);
  });
});

test('redacts the active credential from diagnostic text', async () => {
  await withConfig(async (configuration) => {
    await configuration.configure({
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'sk-sensitive',
    });
    assert.equal(configuration.redact('request failed with sk-sensitive'), 'request failed with ***');
  });
});
