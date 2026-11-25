import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiMcpClient } from '../src/capabilities/api-mcp-client.js';
import { enrichSimulationLoginReply } from '../src/capabilities/simulation-login-reply.js';
import { fetchSimulationLoginToken } from '../src/capabilities/simulation-login.js';
import {
  recordSimulationLoginToken,
  takeSimulationLoginTokens,
} from '../src/capabilities/simulation-login-tokens.js';
import { loadRuntimeConfig } from '../src/config.js';

test('ApiMcpClient：resolve → get_token 成功路径', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      params?: { name?: string; arguments?: { api_id?: string; params?: Record<string, string> } };
    };
    calls.push(body.method || '');
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'api', version: '1' } },
      }), { status: 200 });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'tools/call' && body.params?.arguments?.api_id === 'student.resolve') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          structuredContent: {
            api_id: 'student.resolve',
            data: { uid: '9007199254740993', cardNo: 'CARD1' },
            truncated: false,
          },
        },
      }), { status: 200 });
    }
    if (body.method === 'tools/call' && body.params?.arguments?.api_id === 'student.get_token') {
      assert.equal(body.params.arguments.params?.uid, '9007199254740993');
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: {
          structuredContent: {
            api_id: 'student.get_token',
            data: { uid: '9007199254740993', token: 'sim-token-value' },
            truncated: false,
          },
        },
      }), { status: 200 });
    }
    throw new Error(`unexpected call ${JSON.stringify(body)}`);
  };

  const client = new ApiMcpClient({
    url: 'https://api-mcp.example.test/devtools/mcp/api',
    token: 'test-token-12',
    fetchImpl,
  });
  const result = await fetchSimulationLoginToken(client, 'CARD1');
  assert.equal(result.status, 'ok');
  assert.equal(result.uid, '9007199254740993');
  assert.equal(result.token, 'sim-token-value');
  assert.ok(calls.includes('initialize'));
  assert.ok(calls.includes('tools/call'));
});

test('fetchSimulationLoginToken：无学员 / 无 token', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      params?: { arguments?: { api_id?: string } };
    };
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' },
      }), { status: 200 });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.params?.arguments?.api_id === 'student.resolve') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { structuredContent: { api_id: 'student.resolve', data: null, truncated: false } },
      }), { status: 200 });
    }
    throw new Error('should stop after resolve null');
  };
  const missing = await fetchSimulationLoginToken(new ApiMcpClient({
    url: 'https://api-mcp.example.test/x', token: 'test-token-12', fetchImpl,
  }), 'NOPE');
  assert.equal(missing.status, 'not_found');

  const fetchNoToken: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      params?: { arguments?: { api_id?: string } };
    };
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' },
      }), { status: 200 });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.params?.arguments?.api_id === 'student.resolve') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          structuredContent: {
            api_id: 'student.resolve', data: { uid: '1' }, truncated: false,
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      result: {
        structuredContent: {
          api_id: 'student.get_token', data: { uid: '1', token: null }, truncated: false,
        },
      },
    }), { status: 200 });
  };
  const empty = await fetchSimulationLoginToken(new ApiMcpClient({
    url: 'https://api-mcp.example.test/x', token: 'test-token-12', fetchImpl: fetchNoToken,
  }), '1');
  assert.equal(empty.status, 'no_token');
  assert.equal(empty.uid, '1');
});

test('token 登记与取出', () => {
  recordSimulationLoginToken('msg-1', { uid: '1', token: 'abc' });
  assert.deepEqual(takeSimulationLoginTokens('msg-1'), [{ uid: '1', token: 'abc' }]);
  assert.deepEqual(takeSimulationLoginTokens('msg-1'), []);
});

test('COS 未配置时 enrich 只补文本提示', async () => {
  recordSimulationLoginToken('msg-2', { uid: '9', token: 'tok-xyz' });
  const config = loadRuntimeConfig({
    ...process.env,
    API_MCP_URL: '',
    API_MCP_TOKEN: '',
    COS_SECRET_ID: '',
    COS_SECRET_KEY: '',
    COS_REGION: '',
    COS_BUCKET: '',
  });
  const text = await enrichSimulationLoginReply({
    text: '判定：信息查询\n\n已查到 Token。',
    messageId: 'msg-2',
    owner: '080230',
    config,
  });
  assert.match(text, /tok-xyz/);
  assert.match(text, /二维码未能展示/);
});

test('extractCosSignedUrl：兼容 SDK 返回 { Url } 对象', async () => {
  const { extractCosSignedUrl } = await import('../src/capabilities/cos-store.js');
  assert.equal(
    extractCosSignedUrl({ Url: 'https://cos.example/a.png?sign=1' }),
    'https://cos.example/a.png?sign=1',
  );
  assert.equal(
    extractCosSignedUrl('https://cos.example/b.png?sign=2'),
    'https://cos.example/b.png?sign=2',
  );
  assert.throws(() => extractCosSignedUrl({}), /URL/);
  assert.throws(() => extractCosSignedUrl(null), /URL/);
});

test('fetchSimulationLoginToken：resolve UPSTREAM_ERROR 且 identifier 为 uid 形态时降级查 Token', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      params?: { arguments?: { api_id?: string; params?: Record<string, string> } };
    };
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' },
      }), { status: 200 });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.params?.arguments?.api_id === 'student.resolve') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          isError: true,
          content: [{ type: 'text', text: '{"message":"业务查询失败，不能据此判断无数据","code":"UPSTREAM_ERROR","retryable":false}' }],
          structuredContent: {
            message: '业务查询失败，不能据此判断无数据',
            code: 'UPSTREAM_ERROR',
            retryable: false,
          },
        },
      }), { status: 200 });
    }
    if (body.params?.arguments?.api_id === 'student.get_token') {
      assert.equal(body.params.arguments.params?.uid, '2592373');
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: {
          structuredContent: {
            api_id: 'student.get_token',
            data: { uid: '2592373', token: 'sim-degraded-token' },
            truncated: false,
          },
        },
      }), { status: 200 });
    }
    throw new Error(`unexpected ${JSON.stringify(body)}`);
  };
  const result = await fetchSimulationLoginToken(new ApiMcpClient({
    url: 'https://api-mcp.example.test/x', token: 'test-token-12', fetchImpl,
  }), '2592373');
  assert.equal(result.status, 'ok');
  assert.equal(result.uid, '2592373');
  assert.equal(result.token, 'sim-degraded-token');
  assert.match(String(result.message || ''), /身份核实|resolve|降级/i);
});
