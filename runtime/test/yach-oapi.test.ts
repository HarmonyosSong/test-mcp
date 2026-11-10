import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import {
  progressLabelForTool,
  validateYachEndpoint,
  YachAPIError,
  YachOAPI,
} from '../src/channels/yach/index.js';
import { decryptIdentifier, parseYachEvent } from '../src/channels/yach/parse.js';
import { createCipheriv } from 'node:crypto';
import { loadRuntimeConfig } from '../src/config.js';

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

function encryptId(plain: string, appKey: string): string {
  const key = Buffer.from(appKey.slice(0, 16).padEnd(16, '\0'), 'utf8');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

test('loads Yach IM config and keeps it disabled by default', () => {
  const disabled = loadRuntimeConfig({});
  assert.equal(disabled.yachEnabled, false);
  assert.equal(disabled.yachAppKey, '');

  const enabled = loadRuntimeConfig({
    HARMONY_AGENT_YACH_ENABLED: 'true',
    HARMONY_AGENT_YACH_APP_KEY: 'key-from-harmony',
    HARMONY_AGENT_YACH_APP_SECRET: 'secret',
    YACH_APP_KEY: 'ignored-when-harmony-set',
  });
  assert.equal(enabled.yachEnabled, true);
  assert.equal(enabled.yachAppKey, 'key-from-harmony');
  assert.equal(enabled.yachAppSecret, 'secret');
  assert.equal(enabled.yachBaseUrl, 'https://yach-oapi.zhiyinlou.com');
});

test('rejects non-HTTPS Yach endpoints', () => {
  assert.throws(() => validateYachEndpoint('http://example.com'), /HTTPS/);
  assert.throws(() => validateYachEndpoint('https://user:pass@example.com'), /credentials/);
  assert.equal(validateYachEndpoint('https://yach-oapi.zhiyinlou.com/'), 'https://yach-oapi.zhiyinlou.com');
});

test('maps tool names to medium progress labels', () => {
  assert.equal(progressLabelForTool('search_knowledge'), '正在查阅知识库');
  assert.equal(progressLabelForTool('repository_read_file'), '正在读取代码证据');
  assert.equal(progressLabelForTool('resolve_log_target'), '正在查询远程日志');
  assert.equal(progressLabelForTool('other_tool'), '正在收集证据');
});

test('decrypts platform identifiers and parses private text events', () => {
  const appKey = '0123456789abcdef';
  const senderId = encryptId('user-1', appKey);
  const msgId = encryptId('msg-1', appKey);
  const conversationId = encryptId('conv-1', appKey);
  assert.equal(decryptIdentifier(senderId, appKey), 'user-1');

  const event = parseYachEvent({
    data: {
      msgtype: 'text',
      conversationType: '1',
      createAt: Date.now(),
      senderId,
      msgId,
      conversationId,
      userJson: { workCode: '080230', name: 'Tester' },
      content: '启动页白屏',
    },
  }, appKey);
  assert.equal(event.workCode, '080230');
  assert.equal(event.text, '启动页白屏');
  assert.equal(event.toId, 'user-1');
});

test('OAPI obtains token, creates card, pushes, closes, and sends markdown', async () => {
  const calls: string[] = [];
  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/gettoken') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        code: 200,
        obj: { access_token: 'tok', expired_time: Math.floor(Date.now() / 1000) + 3600 },
      }));
      return;
    }
    const body = await readBody(req);
    if (url.pathname === '/openapi/v2/msg_card/create') {
      assert.match(body, /"to_id":"user-1"/);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, obj: { msg_id: 'card-1' } }));
      return;
    }
    if (url.pathname === '/openapi/v2/msg_content/push' || url.pathname === '/openapi/v2/msg_card/close') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, obj: {} }));
      return;
    }
    if (url.pathname === '/v1/single/message/send') {
      assert.match(body, /to_user_id=user-1/);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, obj: {} }));
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });

  try {
    const httpsOrigin = server.origin.replace('http://', 'https://');
    const api = new YachOAPI({
      baseUrl: httpsOrigin,
      appKey: 'k',
      appSecret: 's',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(url.replace(httpsOrigin, server.origin), init);
      },
    });
    const cardId = await api.createCard({ toId: 'user-1', conversationType: '1' });
    assert.equal(cardId, 'card-1');
    await api.pushCard(cardId, 'progress');
    await api.closeCard(cardId);
    await api.sendMarkdown({ toId: 'user-1', conversationType: '1' }, 'hello');
    assert.deepEqual(calls, [
      'GET /gettoken',
      'POST /openapi/v2/msg_card/create',
      'POST /openapi/v2/msg_content/push',
      'POST /openapi/v2/msg_card/close',
      'POST /v1/single/message/send',
    ]);
  } finally {
    await server.close();
  }
});

test('OAPI surfaces safe errors without leaking bodies', async () => {
  const server = await listen((_req, res) => {
    res.statusCode = 500;
    res.end('secret-token-in-body');
  });
  try {
    const api = new YachOAPI({
      baseUrl: 'https://example.invalid',
      appKey: 'k',
      appSecret: 's',
      fetchImpl: async () => fetch(`http://127.0.0.1:${new URL(server.origin).port}/gettoken`),
    });
    await assert.rejects(() => api.sendMarkdown({ toId: 'u', conversationType: '1' }, 'x'), (error: unknown) => {
      assert.ok(error instanceof YachAPIError);
      assert.doesNotMatch(String(error), /secret-token/);
      return true;
    });
  } finally {
    await server.close();
  }
});
