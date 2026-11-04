import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelRoutes } from '../src/http/models.js';
import { MODEL_PROVIDER_PRESETS, ModelConfigurationError, type ModelConfiguration } from '../src/model/configuration.js';

const providerPresets = [{
  id: 'deepseek',
  name: 'DeepSeek',
  base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-chat',
  suggested_models: ['deepseek-chat'],
  requires_api_key: true,
  api_key_env: 'DEEPSEEK_API_KEY',
  note: '',
}];

const configuredStatus = {
  mode: 'model',
  configured: true,
  provider: 'deepseek',
  provider_name: 'DeepSeek',
  model_name: 'deepseek-chat',
  base_url: 'https://api.deepseek.com',
  api_key_configured: true,
  source: 'runtime',
  compatibility_mode: 'standard',
};

const demoStatus = {
  mode: 'demo',
  configured: false,
  provider: null,
  provider_name: null,
  model_name: null,
  base_url: null,
  api_key_configured: false,
  source: null,
  compatibility_mode: 'standard',
};

function createRoutes(): ReturnType<typeof createModelRoutes> {
  const configuration = {
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async configure() { return configuredStatus; },
    async disable() { return demoStatus; },
    async configuredDiscovery() {
      throw new ModelConfigurationError('model provider is not configured');
    },
    async resolveDiscovery(input: { provider: string }) {
      return {
        provider: input.provider,
        base_url: 'https://models.example/v1',
        api_key: null,
      };
    },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  return createModelRoutes(configuration);
}

test('model provider and status routes return their response contracts', async () => {
  const routes = createRoutes();

  const providers = await routes.request('/model/providers');
  assert.equal(providers.status, 200);
  assert.deepEqual(await providers.json(), providerPresets);

  const status = await routes.request('/model/status');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), demoStatus);
});

test('model config routes return configured and disabled status contracts', async () => {
  const routes = createRoutes();
  const configured = await routes.request('/model/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'offline-test-key' }),
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(await configured.json(), configuredStatus);

  const disabled = await routes.request('/model/config', { method: 'DELETE' });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), demoStatus);
});

test('unexpected model configuration and discovery failures remain server errors', async () => {
  const configuration = {
    ...({} as ModelConfiguration),
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async configure() { throw new Error('configuration store unavailable'); },
    async configuredDiscovery() { throw new Error('unexpected discovery failure'); },
    async resolveDiscovery() { throw new Error('unexpected discovery failure'); },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);

  const configure = await routes.request('/model/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', model_name: 'deepseek-chat' }),
  });
  assert.equal(configure.status, 500);

  const configuredDiscovery = await routes.request('/model/available-models');
  assert.equal(configuredDiscovery.status, 500);

  const unconfiguredDiscovery = await routes.request('/model/available-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'custom', base_url: 'https://models.example/v1', no_api_key: true }),
  });
  assert.equal(unconfiguredDiscovery.status, 500);
});

test('model configuration domain validation errors return 422', async () => {
  const configuration = {
    async configure() { throw new ModelConfigurationError('api_key is required for this provider'); },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const response = await routes.request('/model/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', model_name: 'deepseek-chat' }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { detail: 'api_key is required for this provider' });
});

test('unexpected provider, status, disable, and connection-test failures remain server errors', async () => {
  const configuration = {
    providers() { throw new Error('provider catalog unavailable'); },
    status() { throw new Error('configuration read unavailable'); },
    async disable() { throw new Error('configuration delete unavailable'); },
    async resolveDiscovery() { throw new Error('connection setup unavailable'); },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const requests = [
    routes.request('/model/providers'),
    routes.request('/model/status'),
    routes.request('/model/config', { method: 'DELETE' }),
    routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', model_name: 'deepseek-chat' }),
    }),
  ];
  const responses = await Promise.all(requests);
  for (const response of responses) assert.equal(response.status, 500);
});

test('available models returns 409 when no model provider is configured', async () => {
  const routes = createRoutes();

  const response = await routes.request('/model/available-models');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { detail: 'model provider is not configured' });
});

test('configured model discovery maps an upstream HTTP failure to 502', async () => {
  const configuration = {
    providers() { return providerPresets; },
    status() { return configuredStatus; },
    async configuredDiscovery() { return { provider: 'deepseek', base_url: 'https://models.example/v1', api_key: 'test-secret' }; },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'upstream temporarily unavailable' }), { status: 503 });
  try {
    const response = await routes.request('/model/available-models');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { detail: '模型列表获取失败：upstream temporarily unavailable' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('configured model discovery maps network rejection to a redacted 502 response', async () => {
  const secret = 'configured-discovery-network-secret';
  const configuration = {
    providers() { return providerPresets; },
    status() { return configuredStatus; },
    async configuredDiscovery() { return { provider: 'deepseek', base_url: 'https://models.example/v1', api_key: secret }; },
    redact(value: string) { return value.split(secret).join('[REDACTED]'); },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(`socket failed for ${secret}`); };

  try {
    const response = await routes.request('/model/available-models');
    assert.equal(response.status, 502);
    const body = await response.json() as { detail: string };
    assert.match(body.detail, /socket failed for \[REDACTED\]/);
    assert.equal(body.detail.includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model discovery maps malformed provider catalog responses to 502', async () => {
  const routes = createRoutes();
  const originalFetch = globalThis.fetch;

  try {
    for (const payload of [null, 'invalid', { data: { id: 'not-an-array' } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      const response = await routes.request('/model/available-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'custom', base_url: 'https://models.example/v1', no_api_key: true }),
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { detail: '模型列表获取失败：模型列表响应格式无效' });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request-scoped model discovery maps network rejection to a redacted 502 response', async () => {
  const secret = 'request-discovery-network-secret';
  const configuration = {
    async resolveDiscovery(input: { api_key?: string }) {
      return { provider: 'custom', base_url: 'https://models.example/v1', api_key: input.api_key ?? null };
    },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(`socket failed for ${secret}`); };

  try {
    const response = await routes.request('/model/available-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', base_url: 'https://models.example/v1', api_key: secret }),
    });
    assert.equal(response.status, 502);
    const body = await response.json() as { detail: string };
    assert.match(body.detail, /socket failed for \[REDACTED\]/);
    assert.equal(body.detail.includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model discovery redacts a request key echoed by the upstream error', async () => {
  const routes = createRoutes();
  const originalFetch = globalThis.fetch;
  const requestKey = 'temporary-discovery-secret';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: `invalid key ${requestKey}` }), { status: 401 });
  try {
    const response = await routes.request('/model/available-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', base_url: 'https://models.example/v1', api_key: requestKey }),
    });
    assert.equal(response.status, 502);
    const body = await response.json() as { detail: string };
    assert.match(body.detail, /invalid key \[REDACTED\]/);
    assert.equal(body.detail.includes(requestKey), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model route request schema errors return 422', async () => {
  const routes = createRoutes();

  const invalidConfig = await routes.request('/model/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'unknown', model_name: '' }),
  });
  assert.equal(invalidConfig.status, 422);
  assert.ok(Array.isArray((await invalidConfig.json() as { detail: unknown }).detail));

  const availableModels = await routes.request('/model/available-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'x', api_key: 'validation-secret-sentinel' }),
  });
  assert.equal(availableModels.status, 422);
  const availableError = await availableModels.json() as { detail: Array<{ type: string; loc: unknown[]; msg: string }> };
  assert.ok(Array.isArray(availableError.detail));
  assert.ok(availableError.detail.some((issue) => issue.loc[0] === 'body' && issue.loc[1] === 'provider'));
  assert.equal(JSON.stringify(availableError).includes('validation-secret-sentinel'), false);

  const modelTest = await routes.request('/model/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'x', model_name: '' }),
  });
  assert.equal(modelTest.status, 422);
  const modelError = await modelTest.json() as { detail: Array<{ type: string; loc: unknown[]; msg: string }> };
  assert.ok(Array.isArray(modelError.detail));
  assert.ok(modelError.detail.some((issue) => issue.loc[0] === 'body' && issue.loc[1] === 'model_name'));

  const malformed = await routes.request('/model/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 422);
  assert.deepEqual((await malformed.json() as { detail: unknown[] }).detail[0], {
    type: 'json_invalid', loc: ['body'], msg: 'invalid JSON body',
  });
});

test('model route upstream HTTP errors remain 502', async () => {
  const routes = createRoutes();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });

  try {
    const availableModels = await routes.request('/model/available-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', base_url: 'https://models.example/v1', no_api_key: true }),
    });
    assert.equal(availableModels.status, 502);

    const modelTest = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom',
        model_name: 'local-model',
        base_url: 'https://models.example/v1',
        no_api_key: true,
      }),
    });
    assert.equal(modelTest.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model connection test maps network rejection to a redacted 502 response', async () => {
  const requestKey = 'connection-failure-key-sentinel';
  const configuration = {
    async resolveDiscovery() {
      return { provider: 'custom', base_url: 'https://models.example/v1', api_key: requestKey };
    },
    redact(value: string) { return value.split(requestKey).join('[REDACTED]'); },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => { throw new Error(`connection refused for ${requestKey}`); };
    const rejected = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model_name: 'local-model', base_url: 'https://models.example/v1', api_key: requestKey }),
    });
    assert.equal(rejected.status, 502);
    const body = await rejected.json() as { detail: string };
    assert.match(body.detail, /connection refused for \[REDACTED\]/);
    assert.equal(body.detail.includes(requestKey), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model connection test rejects a missing provider API key before making a request', async () => {
  let requests = 0;
  const configuration = {
    async resolveDiscovery() { return { provider: 'custom', base_url: 'https://models.example/v1', api_key: null }; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests += 1; return new Response('{}'); };

  try {
    const response = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model_name: 'local-model', base_url: 'https://models.example/v1' }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { detail: 'api_key is required for this provider' });
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('all provider presets use their configured model-discovery and connection-test endpoints', async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; body?: Record<string, unknown> }> = [];
  const configuration = {
    providers() { return MODEL_PROVIDER_PRESETS; },
    status() { return demoStatus; },
    async configure() { return configuredStatus; },
    async disable() { return demoStatus; },
    async configuredDiscovery() { throw new ModelConfigurationError('model provider is not configured'); },
    async resolveDiscovery(input: { provider: string; base_url?: string }) {
      const preset = MODEL_PROVIDER_PRESETS.find(({ id }) => id === input.provider)!;
      return {
        provider: preset.id,
        base_url: input.base_url || preset.base_url || 'http://127.0.0.1:11434/v1',
        api_key: preset.id === 'custom' ? null : `route-test-${preset.id}-secret`,
      };
    },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    });
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'mock-model' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  };

  try {
    for (const preset of MODEL_PROVIDER_PRESETS) {
      const baseUrl = preset.id === 'custom' ? 'http://127.0.0.1:11434/v1' : preset.base_url;
      const discovery = await routes.request('/model/available-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: preset.id, ...(preset.id === 'custom' ? { base_url: baseUrl, no_api_key: true } : {}) }),
      });
      assert.equal(discovery.status, 200, preset.id);
      assert.deepEqual(await discovery.json(), ['mock-model']);

      const connection = await routes.request('/model/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: preset.id,
          model_name: `test-${preset.id}`,
          ...(preset.id === 'custom' ? { base_url: baseUrl, no_api_key: true } : {}),
        }),
      });
      assert.equal(connection.status, 200, preset.id);
      assert.equal((await connection.json() as { ok: boolean }).ok, true);

      const root = baseUrl.replace(/\/$/, '');
      const providerRequests = requests.slice(-2);
      assert.deepEqual(providerRequests.map(({ url, method }) => [url, method]), [
        [`${root}/models`, 'GET'],
        [`${root}/chat/completions`, 'POST'],
      ]);
      if (preset.id === 'moonshot') {
        assert.equal(providerRequests[1]?.body?.max_tokens, 128);
        assert.equal(providerRequests[1]?.body?.reasoning_effort, 'low');
      }
      const expectedAuthorization = preset.id === 'custom' ? null : `Bearer route-test-${preset.id}-secret`;
      assert.deepEqual(providerRequests.map(({ authorization }) => authorization), [expectedAuthorization, expectedAuthorization]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model test redacts the configured credential from upstream errors', async () => {
  const secret = 'sensitive-provider-token';
  const configuration = {
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async configure() { return configuredStatus; },
    async disable() { return demoStatus; },
    async configuredDiscovery() { return { base_url: 'https://models.example/v1', api_key: secret }; },
    async resolveDiscovery() { return { provider: 'custom', base_url: 'https://models.example/v1', api_key: secret }; },
    redact(value: string) { return value.replaceAll(secret, '***'); },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: `rejected ${secret}` }), { status: 401 });

  try {
    const response = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model_name: 'local-model', no_api_key: true }),
    });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    assert.match(body, /\*\*\*/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model test redacts a configured credential from a successful response preview', async () => {
  const secret = 'configured-preview-secret';
  const configuration = {
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async resolveDiscovery() { return { provider: 'custom', base_url: 'https://models.example/v1', api_key: secret }; },
    redact(value: string) { return value.replaceAll(secret, '[REDACTED]'); },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: `returned ${secret}` } }] }), { status: 200 });
  try {
    const response = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model_name: 'local-model', no_api_key: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { response_preview: string };
    assert.equal(body.response_preview, 'returned [REDACTED]');
    assert.equal(body.response_preview.includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model test redacts a request-specific credential echoed by the provider', async () => {
  const secret = 'request-only-secret-sentinel';
  const configuration = {
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async configure() { return configuredStatus; },
    async disable() { return demoStatus; },
    async configuredDiscovery() { return { base_url: 'https://models.example/v1', api_key: null }; },
    async resolveDiscovery(input: { api_key?: string | null }) {
      return { provider: 'custom', base_url: 'https://models.example/v1', api_key: input.api_key ?? null };
    },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: `rejected ${secret}` }), { status: 401 });

  try {
    const response = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model_name: 'local-model', api_key: secret }),
    });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    assert.match(body, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model test redacts a request-specific credential from a successful response preview', async () => {
  const secret = 'request-only-preview-secret';
  const configuration = {
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async configure() { return configuredStatus; },
    async disable() { return demoStatus; },
    async configuredDiscovery() { return { base_url: 'https://models.example/v1', api_key: null }; },
    async resolveDiscovery(input: { api_key?: string | null }) {
      return { provider: 'custom', base_url: 'https://models.example/v1', api_key: input.api_key ?? null };
    },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: `echo ${secret}` } }] }), { status: 200 });

  try {
    const response = await routes.request('/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model_name: 'local-model', api_key: secret }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    assert.match(body, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model test rejects successful HTTP responses without non-empty model text', async () => {
  const configuration = {
    providers() { return providerPresets; },
    status() { return demoStatus; },
    async configure() { return configuredStatus; },
    async disable() { return demoStatus; },
    async configuredDiscovery() { return { base_url: 'https://models.example/v1', api_key: null }; },
    async resolveDiscovery() { return { provider: 'custom', base_url: 'https://models.example/v1', api_key: null }; },
    redact(value: string) { return value; },
  } as unknown as ModelConfiguration;
  const routes = createModelRoutes(configuration);
  const originalFetch = globalThis.fetch;
  const malformedBodies = [
    '{}',
    '{"choices":[]}',
    '{"choices":[{}]}',
    '{"choices":[{"message":{}}]}',
    '{"choices":[{"message":{"content":"  "}}]}',
    'not-json',
  ];
  try {
    for (const body of malformedBodies) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      const response = await routes.request('/model/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'custom', model_name: 'local-model', no_api_key: true }),
      });
      assert.equal(response.status, 502, body);
      assert.deepEqual(await response.json(), { detail: '模型连接失败：模型未返回有效文本' });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
