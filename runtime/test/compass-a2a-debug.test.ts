import assert from 'node:assert/strict';
import test from 'node:test';

import { Hono } from 'hono';

import {
  CompassA2AClient,
  CompassA2AError,
  type CompassA2AProgress,
} from '../src/capabilities/compass-a2a.js';
import { createCompassA2ADebugRoutes } from '../src/capabilities/compass-a2a-debug.js';
import type { ModelConfiguration } from '../src/model/configuration.js';

type DoStream = (options: {
  abortSignal?: AbortSignal;
  prompt: unknown;
}) => Promise<{ stream: ReadableStream<unknown> }>;

function harness(doStream: DoStream) {
  const modelConfiguration = {
    languageModel: async () => ({ doStream }),
  } as unknown as ModelConfiguration;
  const app = new Hono();
  app.route('/', createCompassA2ADebugRoutes({ token: 'local-debug-token', modelConfiguration }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    return app.request(request);
  };
  const client = new CompassA2AClient({
    baseUrl: 'http://a2a-debug.test',
    clientId: 'runtime-test',
    token: 'local-debug-token',
    waitSeconds: 5,
    fetch: fetchImpl,
  });
  return { app, client };
}

function textStream(chunks: string[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const [index, delta] of chunks.entries()) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
        if (index === chunks.length - 1) controller.close();
      }
    },
  });
}

test('本地调试提供端与真实 CompassA2AClient 完成 Agent Card、流式 artifact 和终态交互', async () => {
  let prompt: unknown;
  const first = '服务端核查方向'.repeat(60);
  const { app, client } = harness(async (options) => {
    prompt = options.prompt;
    return { stream: textStream([first, '还需要补充 traceId。']) };
  });
  app.get('/xesapp-agent/api/health', (context) => context.json({ status: 'ok' }));
  const health = await app.request('http://a2a-debug.test/xesapp-agent/api/health');
  assert.equal(health.status, 200, '调试端认证不得泄漏到产品 API');
  const card = await client.fetchAgentCard();
  assert.equal(card.capabilities?.streaming, true);
  assert.equal(card.supportedInterfaces[0]?.protocolBinding, 'JSONRPC');
  const partials: string[] = [];
  const result = await client.sendStreamingMessage({
    text: '页面请求失败，请协查服务端。',
    contextId: 'context-fixed',
    onPartialResult: (partial) => partials.push(partial.text),
  });
  assert.equal(result.state, 'TASK_STATE_COMPLETED');
  assert.equal(result.contextId, 'context-fixed');
  assert.ok(result.taskId);
  assert.equal(result.text, `${first}\n还需要补充 traceId。`);
  assert.deepEqual(partials, [first, result.text]);
  assert.match(JSON.stringify(prompt), /不得声称查询过真实服务端/);
  assert.match(JSON.stringify(prompt), /页面请求失败/);
});

test('CancelTask 中断模型流并保留已发送的半截 artifact', async () => {
  const first = '甲'.repeat(400);
  const { client } = harness(async ({ abortSignal }) => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: first });
        abortSignal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    }),
  }));
  let cancellation: Promise<void> | undefined;
  const result = await client.sendStreamingMessage({
    text: '需要取消的协查任务',
    onProgress: (progress: CompassA2AProgress) => {
      if (progress.kind === 'artifact' && progress.taskId && !cancellation) {
        cancellation = client.cancelTask(progress.taskId);
      }
    },
  });
  await cancellation;
  assert.equal(result.state, 'TASK_STATE_CANCELED');
  assert.equal(result.text, first);
});

test('认证失败和模型失败不会伪造成完成状态', async () => {
  const { app, client } = harness(async () => { throw new Error('provider unavailable'); });
  const unauthorized = await app.request('http://a2a-debug.test/compass/.well-known/agent-card.json', {
    headers: { Authorization: 'Bearer wrong', 'A2A-Version': '1.0' },
  });
  assert.equal(unauthorized.status, 401);
  await assert.rejects(
    () => client.sendStreamingMessage({ text: '触发模型失败' }),
    (error: unknown) => error instanceof CompassA2AError && error.code === 'TASK_STATE_FAILED',
  );
});
