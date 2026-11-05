import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import {
  CompassA2AClient,
  CompassA2AError,
  isCompassA2AConfigured,
  normalizeCompassA2ABaseUrl,
} from '../src/capabilities/compass-a2a.js';
import { A2A_CONFIG_DEFAULTS, compassA2AClientConfig, loadRuntimeConfig } from '../src/config.js';

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('configures A2A settings and treats empty token as disabled', () => {
  assert.equal(isCompassA2AConfigured(''), false);
  assert.equal(isCompassA2AConfigured('  '), false);
  assert.equal(isCompassA2AConfigured('token'), true);

  const enabled = loadRuntimeConfig({
    HARMONY_AGENT_A2A_BASE_URL: `${A2A_CONFIG_DEFAULTS.baseUrl}/`,
    HARMONY_AGENT_A2A_CLIENT_ID: A2A_CONFIG_DEFAULTS.clientId,
    HARMONY_AGENT_A2A_TOKEN: 'secret-token',
    HARMONY_AGENT_A2A_WAIT_SECONDS: '120',
  });
  assert.equal(enabled.a2aBaseUrl, A2A_CONFIG_DEFAULTS.baseUrl);
  assert.equal(enabled.a2aClientId, A2A_CONFIG_DEFAULTS.clientId);
  assert.equal(enabled.a2aToken, 'secret-token');
  assert.equal(enabled.a2aWaitSeconds, 120);
  assert.deepEqual(compassA2AClientConfig(enabled), {
    baseUrl: A2A_CONFIG_DEFAULTS.baseUrl,
    clientId: A2A_CONFIG_DEFAULTS.clientId,
    token: 'secret-token',
    waitSeconds: 120,
  });

  const disabled = loadRuntimeConfig({
    HARMONY_AGENT_A2A_TOKEN: '',
  });
  assert.equal(disabled.a2aBaseUrl, A2A_CONFIG_DEFAULTS.baseUrl);
  assert.equal(disabled.a2aClientId, A2A_CONFIG_DEFAULTS.clientId);
  assert.equal(disabled.a2aWaitSeconds, A2A_CONFIG_DEFAULTS.waitSeconds);
  assert.equal(disabled.a2aToken, '');
  assert.equal(isCompassA2AConfigured(disabled.a2aToken), false);
});

test('rejects A2A base URLs that include /compass or credentials', () => {
  assert.equal(normalizeCompassA2ABaseUrl(`${A2A_CONFIG_DEFAULTS.baseUrl}/`), A2A_CONFIG_DEFAULTS.baseUrl);
  assert.throws(() => normalizeCompassA2ABaseUrl(`${A2A_CONFIG_DEFAULTS.baseUrl}/compass`), /origin only/);
  assert.throws(() => normalizeCompassA2ABaseUrl('https://user:pass@example.com'), /credentials/);
});

test('fetches agent card, streams final text, and cancels tasks over JSON-RPC SSE', async () => {
  const requests: Array<{ method?: string; url?: string; auth?: string; clientId?: string; body?: string }> = [];
  const server = await listen(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : '';
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      clientId: req.headers['x-a2a-client-id'] as string | undefined,
      body,
    });
    if (req.method === 'GET' && req.url === '/compass/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: 'Compass',
        capabilities: { streaming: true },
        supportedInterfaces: [{
          url: `${server.origin}/compass/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/compass/a2a') {
      const payload = JSON.parse(body) as { method: string; params?: { id?: string; message?: { contextId?: string } } };
      if (payload.method === 'CancelTask') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: '2', result: { id: payload.params?.id } }));
        return;
      }
      assert.equal(payload.method, 'SendStreamingMessage');
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const contextId = payload.params?.message?.contextId ?? 'ctx-1';
      res.write(`data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: {
          task: {
            id: 'task-1',
            contextId,
            status: { state: 'TASK_STATE_WORKING' },
          },
        },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: {
          artifactUpdate: {
            taskId: 'task-1',
            contextId,
            artifact: { artifactId: 'a1', name: '排查报告', parts: [{ text: 'final answer' }] },
            lastChunk: true,
          },
        },
      })}\n\n`);
      res.end(`data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: {
          statusUpdate: {
            taskId: 'task-1',
            contextId,
            status: { state: 'TASK_STATE_COMPLETED' },
          },
        },
      })}\n\n`);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });

  try {
    const client = new CompassA2AClient({
      baseUrl: server.origin,
      clientId: A2A_CONFIG_DEFAULTS.clientId,
      token: 'test-token',
      waitSeconds: 5,
    });
    const card = await client.fetchAgentCard();
    assert.equal(card.name, 'Compass');
    assert.equal(card.capabilities?.streaming, true);

    const progress: string[] = [];
    const result = await client.sendStreamingMessage({
      text: 'hello',
      contextId: 'ctx-reuse',
      onProgress: (event) => progress.push(event.kind),
    });
    assert.equal(result.text, 'final answer');
    assert.equal(result.taskId, 'task-1');
    assert.equal(result.contextId, 'ctx-reuse');
    assert.equal(result.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(progress, ['task', 'artifact', 'status']);

    await client.cancelTask('task-1');
    assert.equal(requests[0]?.auth, 'Bearer test-token');
    assert.equal(requests[0]?.clientId, A2A_CONFIG_DEFAULTS.clientId);
    assert.match(requests[1]?.body ?? '', /ROLE_USER/);
    assert.match(requests[1]?.body ?? '', /ctx-reuse/);
    assert.match(requests[2]?.body ?? '', /CancelTask/);
  } finally {
    await server.close();
  }
});

test('rejects agent cards whose RPC path or origin does not match', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      supportedInterfaces: [{
        url: 'https://other.example/compass/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      }],
    }));
  });
  try {
    const client = new CompassA2AClient({
      baseUrl: server.origin,
      clientId: A2A_CONFIG_DEFAULTS.clientId,
      token: 'test-token',
      waitSeconds: A2A_CONFIG_DEFAULTS.waitSeconds,
    });
    await assert.rejects(() => client.fetchAgentCard(), (error: unknown) => {
      assert.ok(error instanceof CompassA2AError);
      assert.match(error.message, /origin must match/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('surfaces JSON-RPC stream errors', async () => {
  const server = await listen(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        supportedInterfaces: [{
          url: `${server.origin}/compass/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        }],
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      error: { code: -32602, message: 'Validation failed' },
    }));
  });
  try {
    const client = new CompassA2AClient({
      baseUrl: server.origin,
      clientId: A2A_CONFIG_DEFAULTS.clientId,
      token: 'test-token',
      waitSeconds: A2A_CONFIG_DEFAULTS.waitSeconds,
    });
    await assert.rejects(() => client.sendStreamingMessage({ text: 'hello' }), /Validation failed/);
  } finally {
    await server.close();
  }
});
