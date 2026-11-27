import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ModelConfiguration, ModelConfigurationError, transformRelaxedRequestBody } from '../src/model/configuration.js';

async function withConfig(
  run: (config: ModelConfiguration, filePath: string, directory: string) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
  fetchImpl?: typeof globalThis.fetch,
) {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-model-config-'));
  const filePath = join(directory, 'model-config.json');
  try {
    await run(new ModelConfiguration({ filePath, env, fetch: fetchImpl }), filePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('exposes the legacy provider presets without network access', async () => {
  await withConfig(async (configuration) => {
    const presets = configuration.providers();
    assert.deepEqual(presets.map(({ id, name, base_url, default_model, suggested_models, api_key_env, requires_api_key, note }) => ({
      id, name, base_url, default_model, suggested_models, api_key_env, requires_api_key, note,
    })), [
      { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', default_model: 'gpt-5.2', suggested_models: ['gpt-5.2', 'gpt-5-mini'], api_key_env: 'OPENAI_API_KEY', requires_api_key: true, note: '当前没有真实 provider 调用与诊断质量验收记录；连接测试通过不代表诊断质量已验收。' },
      { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com', default_model: 'deepseek-flash', suggested_models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'], api_key_env: 'DEEPSEEK_API_KEY', requires_api_key: true, note: 'deepseek-flash 已通过本仓库七轮代表性评测及逐轮复核；这是回归样本，不代表总体质量保证。' },
      { id: 'qwen', name: '通义千问（DashScope）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', default_model: 'qwen-plus', suggested_models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], api_key_env: 'DASHSCOPE_API_KEY', requires_api_key: true, note: '当前没有真实 provider 调用与诊断质量验收记录。企业 Workspace 可将 Base URL 替换为对应地域的 maas.aliyuncs.com 地址。' },
      { id: 'moonshot', name: 'Moonshot / Kimi', base_url: 'https://api.kimi.com/coding/v1', default_model: 'kimi-for-coding', suggested_models: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed'], api_key_env: 'MOONSHOT_API_KEY', requires_api_key: true, note: 'Kimi Code 端点连接已验证，但 Kimi 全系列当前仅作实验型号；诊断质量尚未达到本项目正式支持门槛。' },
      { id: 'zhipu', name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', default_model: 'glm-5.3', suggested_models: ['glm-5.3', 'glm-4-flash', 'glm-4-plus'], api_key_env: 'ZHIPUAI_API_KEY', requires_api_key: true, note: '当前没有真实 provider 调用与诊断质量验收记录；连接测试通过不代表诊断质量已验收。' },
      { id: 'doubao', name: '火山方舟 / 豆包', base_url: 'https://ark.cn-beijing.volces.com/api/v3', default_model: 'doubao-seed-2-1-pro-260628', suggested_models: ['doubao-seed-2-1-pro-260628'], api_key_env: 'ARK_API_KEY', requires_api_key: true, note: '当前没有真实 provider 调用与诊断质量验收记录。模型字段兼容当前 Model ID、历史 ep-* 接入点和私有部署标识。' },
      { id: 'custom', name: '自定义 OpenAI 兼容接口', base_url: '', default_model: '', suggested_models: [], api_key_env: null, requires_api_key: false, note: '自定义接口仅有本地协议 fixture 验证；请先测试连接并独立验证模型输出。' },
    ]);
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

test('all provider presets map consistently into the shared Mastra chat model factory', async () => {
  await withConfig(async (configuration) => {
    for (const provider of configuration.providers()) {
      const baseUrl = provider.id === 'custom' ? 'http://127.0.0.1:11434/v1' : provider.base_url;
      const modelName = provider.default_model || 'local-model';
      const secret = provider.requires_api_key ? `${provider.id}-test-key` : null;
      await configuration.configure({
        provider: provider.id,
        model_name: modelName,
        ...(provider.id === 'custom' ? { base_url: baseUrl, no_api_key: true } : { api_key: secret }),
      });
      assert.deepEqual(await configuration.agentModel(), {
        provider: provider.id,
        base_url: baseUrl,
        api_key: secret,
        model_id: modelName,
        compatibility_mode: 'standard',
      });
      const model = await configuration.languageModel();
      assert.equal(model.modelId, modelName);
      assert.equal(model.provider, `${provider.id}.chat`);
    }
  });
});

test('all provider presets emit OpenAI-compatible chat requests through the Mastra SDK', async () => {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({
      url: String(input),
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      id: 'chatcmpl-offline-fixture',
      object: 'chat.completion',
      created: 0,
      model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await withConfig(async (configuration) => {
    for (const preset of configuration.providers()) {
      const baseUrl = preset.id === 'custom' ? 'http://127.0.0.1:11434/v1' : preset.base_url;
      const modelName = preset.default_model || 'local-model';
      const apiKey = preset.requires_api_key ? `${preset.id}-fixture-key` : null;
      await configuration.configure({
        provider: preset.id,
        model_name: modelName,
        ...(preset.id === 'custom'
          ? { base_url: baseUrl, no_api_key: true }
          : { api_key: apiKey }),
      });
      const model = await configuration.languageModel();
      const result = await Promise.resolve(model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }));

      const request = requests.at(-1)!;
      assert.equal(request.url, `${baseUrl}/chat/completions`, preset.id);
      assert.equal(request.init.method, 'POST', preset.id);
      const headers = new Headers(request.init.headers);
      assert.equal(headers.get('authorization'), apiKey ? `Bearer ${apiKey}` : null, preset.id);
      assert.equal(request.body.model, modelName, preset.id);
      assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hello' }], preset.id);
      assert.equal((model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs, true, preset.id);
      assert.deepEqual(result.content, [{ type: 'text', text: 'OK' }], preset.id);
      assert.equal(result.finishReason.unified, 'stop', preset.id);
      assert.equal(result.usage.inputTokens.total, 2, preset.id);
      assert.equal(result.usage.outputTokens.total, 1, preset.id);
    }
  }, {}, fetchImpl);
  assert.equal(requests.length, 7);
});

test('relaxed compatibility transforms the actual SDK wire request', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ error: { message: 'offline provider fixture' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };
  await withConfig(async (configuration) => {
    await configuration.configure({
      provider: 'custom',
      model_name: 'local-model',
      base_url: 'http://127.0.0.1:11434/v1',
      no_api_key: true,
      compatibility_mode: 'relaxed',
    });
    const model = await configuration.languageModel();
    await assert.rejects(Promise.resolve(model.doGenerate({
      prompt: [
        { role: 'system', content: 'system one' },
        { role: 'system', content: 'system two' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
      maxOutputTokens: 64,
      responseFormat: {
        type: 'json',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    })));
    assert.equal((model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs, false);
  }, {}, fetchImpl);

  assert.deepEqual(requestBody?.messages, [
    { role: 'system', content: 'system one\n\nsystem two' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(requestBody?.max_tokens, 64);
  assert.equal(requestBody?.max_completion_tokens, undefined);
  assert.deepEqual(requestBody?.response_format, { type: 'json_object' });
});

test('cross-provider legacy conversation overrides fall back to the configured model', async () => {
  await withConfig(async (configuration) => {
    await configuration.configure({
      provider: 'deepseek',
      model_name: 'deepseek-flash',
      api_key: 'deepseek-test-key',
    });

    assert.equal((await configuration.agentModel('openai:gpt-5-mini')).model_id, 'deepseek-flash');
    assert.equal((await configuration.agentModel('deepseek:deepseek-chat')).model_id, 'deepseek-chat');
    assert.equal((await configuration.agentModel('deepseek:')).model_id, 'deepseek-flash');
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

test('environment openai provider honors OPENAI_BASE_URL for compatible gateways', async () => {
  await withConfig(async (_configuration, filePath) => {
    const environment = new ModelConfiguration({
      filePath,
      env: {
        HARMONY_AGENT_MODE: 'model',
        HARMONY_AGENT_MODEL: 'openai:deepseek-v4.1-flash',
        OPENAI_BASE_URL: 'https://test-gateway-openai-inner.speiyou.com/v1',
        OPENAI_API_KEY: 'gateway-secret',
      },
    });
    await environment.initialize();
    assert.equal(environment.status().source, 'environment');
    assert.equal(environment.status().provider, 'openai');
    assert.equal(environment.status().base_url, 'https://test-gateway-openai-inner.speiyou.com/v1');
    assert.deepEqual(await environment.configuredDiscovery(), {
      provider: 'openai',
      base_url: 'https://test-gateway-openai-inner.speiyou.com/v1',
      api_key: 'gateway-secret',
    });
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

test('HARMONY_AGENT_REASONING_EFFORT is injected into chat completion request bodies', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'chatcmpl-reasoning',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withConfig(async (configuration) => {
    await configuration.configure({
      provider: 'custom',
      model_name: 'deepseek-v4.1-flash',
      base_url: 'http://127.0.0.1:9/v1',
      no_api_key: true,
    });
    const model = await configuration.languageModel();
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    assert.equal(requestBody?.reasoning_effort, 'none');
  }, { HARMONY_AGENT_REASONING_EFFORT: 'none' }, fetchImpl);
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
