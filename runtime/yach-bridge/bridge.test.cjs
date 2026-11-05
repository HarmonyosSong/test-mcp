'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const vm = require('node:vm');

const BRIDGE_PATH = path.join(__dirname, 'bridge.cjs');
const CONFIG = {
  type: 'configure', appKey: 'test-key', appSecret: 'test-secret',
  channelAppId: 'channel-app', bizId: '1',
  proxyUrl: 'https://dispatch.example.com/v4/proxy/config',
};

function fakeSdk({ initResult = 0 } = {}) {
  const calls = { init: 0, unInit: 0, require: 0 };
  const handlers = {};
  const channel = {
    on(event, handler) { handlers[event] = handler; },
    unInit() { calls.unInit += 1; },
    init() { calls.init += 1; return initResult; },
  };
  class TalMsgClient {
    static CHANNEL = 'channel';
    setSdkConfig() {}
    getInstance() { return channel; }
  }
  return { module: TalMsgClient, handlers, calls };
}

function loadBridge({ sdk = fakeSdk(), readFile } = {}) {
  const output = [];
  const processHandlers = {};
  const stdin = new EventEmitter();
  const exits = [];
  const intervals = [];
  const timeouts = [];
  const fsModule = { ...fs };
  if (readFile) fsModule.readFileSync = readFile;
  const context = {
    require: (name) => {
      if (name === 'node:fs') return fsModule;
      if (name.endsWith('tal-msg-sdk.cjs')) {
        sdk.calls.require += 1;
        return sdk.module;
      }
      return require(name);
    },
    __dirname,
    Buffer,
    URL,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length - 1; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length - 1; },
    clearInterval: () => {},
    process: {
      stdin: { setEncoding() {}, on: (event, handler) => stdin.on(event, handler) },
      stdout: { writableLength: 0, write: (line) => output.push(line), on() {} },
      on: (event, handler) => { processHandlers[event] = handler; },
      exit: (code) => { exits.push(code); },
    },
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(fs.readFileSync(BRIDGE_PATH, 'utf8'), context, { timeout: 2000 });
  return {
    sdk, exits, intervals, timeouts, processHandlers,
    send: (text) => stdin.emit('data', text),
    frames: () => output.map((line) => JSON.parse(line)),
  };
}

function configure(bridge) {
  bridge.send(JSON.stringify(CONFIG) + '\n');
}

test('bridge gates events until authentication and reports failure reasons', () => {
  const bridge = loadBridge();
  configure(bridge);
  assert.equal(bridge.sdk.calls.init, 1);
  bridge.sdk.handlers.recvMsg({ data: 'before-auth' });
  assert.deepEqual(bridge.frames(), []);
  bridge.sdk.handlers.authResponse({ code: 1 });
  assert.deepEqual(bridge.frames(), [{ type: 'auth_failed', reason: 'credential' }]);
  assert.deepEqual(bridge.exits, [1]);
  assert.equal(bridge.sdk.calls.unInit, 1);
});

test('bridge reports authentication timeout as its own reason', () => {
  const bridge = loadBridge();
  configure(bridge);
  bridge.timeouts[0].fn();
  assert.deepEqual(bridge.frames(), [{ type: 'auth_failed', reason: 'timeout' }]);
  assert.deepEqual(bridge.exits, [1]);
});

test('bridge forwards authenticated events, alive frames and oversized notices', () => {
  const bridge = loadBridge();
  configure(bridge);
  bridge.sdk.handlers.authResponse({ code: 0 });
  bridge.sdk.handlers.recvMsg({ data: 'hello' });
  bridge.sdk.handlers.recvMsg({ data: 'x'.repeat(262144) });
  assert.deepEqual(bridge.frames(), [
    { type: 'authenticated' },
    { type: 'event', payload: { data: 'hello' } },
    { type: 'oversized' },
  ]);
  assert.equal(bridge.intervals.length, 1);
  assert.equal(bridge.intervals[0].ms, 30_000);
  bridge.intervals[0].fn();
  assert.deepEqual(bridge.frames().at(-1), { type: 'alive' });
  bridge.sdk.handlers.netStatusChange({ netStatus: 2 });
  assert.equal(bridge.exits.length, 0);
  bridge.sdk.handlers.netStatusChange({ netStatus: 3 });
  assert.deepEqual(bridge.frames().at(-1), { type: 'disconnected' });
  assert.deepEqual(bridge.exits, [1]);
});

test('bridge refuses a tampered SDK before it is loaded', () => {
  const sdk = fakeSdk();
  const bridge = loadBridge({
    sdk,
    readFile: (file, options) => file.endsWith('tal-msg-sdk.cjs')
      ? Buffer.from('tampered') : fs.readFileSync(file, options),
  });
  configure(bridge);
  assert.equal(sdk.calls.require, 0);
  assert.deepEqual(bridge.frames(), [{ type: 'auth_failed', reason: 'checksum' }]);
  assert.deepEqual(bridge.exits, [1]);
});

test('bridge reports SDK init failure with a stable reason', () => {
  const bridge = loadBridge({ sdk: fakeSdk({ initResult: 1 }) });
  configure(bridge);
  assert.deepEqual(bridge.frames(), [{ type: 'auth_failed', reason: 'sdk_init' }]);
  assert.deepEqual(bridge.exits, [1]);
});

test('vendored SDK integrity and privacy patches are reproducible', () => {
  const source = fs.readFileSync(path.join(__dirname, 'vendor/tal-msg-sdk.cjs'), 'utf8');
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor/provenance.json')));
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), record.vendored_sha256);
  assert.ok(!source.includes('this.remoteLogServer&&post(this.remoteLogServer,{data:e})'));
  assert.ok(!source.includes('this.clientId=getClientId()'));
  let restored = source;
  for (const patch of record.patches.toReversed()) {
    assert.equal(restored.split(patch.after).length - 1, patch.count);
    restored = restored.replaceAll(patch.after, patch.before);
  }
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), record.source_sha256);
});

test('invalid configuration exits with safe protocol output and no credentials', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'bridge.cjs')], {
    input: JSON.stringify({ type: 'configure', appSecret: 'must-not-leak' }) + '\n',
    encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { type: 'auth_failed', reason: 'config' });
  assert.ok(!result.stdout.includes('must-not-leak'));
});

test('locked dependencies load the reviewed SDK without opening a connection', () => {
  const Client = require('./vendor/tal-msg-sdk.cjs');
  assert.equal(Client.getVersion(), '3.4.1');
  const client = new Client('offline-test', '1.0.0');
  assert.match(client.clientId, /^[0-9a-f]{32}$/);
  assert.equal(client.instances.size, 0);
});

test('SDK HTTP transport works with native fetch', { timeout: 5000 }, async (t) => {
  // Expose internal request helpers only in this isolated test context.
  const source = fs.readFileSync(path.join(__dirname, 'vendor/tal-msg-sdk.cjs'), 'utf8');
  const context = {
    require, module: { exports: {} }, process, Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    fetch: globalThis.fetch,
  };
  vm.runInNewContext(source + '\nmodule.exports = { fetch, get, post, option, postAndReturnString };',
    context, { timeout: 2000 });
  const transport = context.module.exports;
  assert.equal(transport.fetch, globalThis.fetch);

  const server = http.createServer(async (request, response) => {
    if (request.url === '/slow') return;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/json' }).end();
      return;
    }
    if (request.url === '/error') {
      response.writeHead(503).end('unavailable');
      return;
    }
    if (request.url === '/invalid') {
      response.end('invalid JSON');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url === '/text') {
      response.end(body);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      method: request.method, body,
      contentType: request.headers['content-type'],
      token: request.headers['x-test-token'],
    }));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (method, route, options = {}) => new Promise((resolve, reject) => {
    transport[method](base + route, options, resolve, (message) => reject(new Error(message)));
  });

  await t.test('GET JSON and redirects preserve response handling', async () => {
    assert.deepEqual(await request('get', '/json', { headers: { 'x-test-token': 'local-only' } }),
      { method: 'GET', body: '', token: 'local-only' });
    assert.deepEqual(await request('get', '/redirect'), { method: 'GET', body: '' });
  });
  await t.test('POST sends JSON and reads JSON or text responses', async () => {
    const options = { data: { message: '本地测试' }, headers: { 'x-test-token': 'local-only' } };
    assert.deepEqual(await request('post', '/json', options), {
      method: 'POST', body: JSON.stringify(options.data),
      contentType: 'application/json', token: 'local-only',
    });
    assert.equal(await request('postAndReturnString', '/text', options), JSON.stringify(options.data));
    assert.equal(await request('option', '/json'), undefined);
  });
  await t.test('HTTP errors and invalid JSON reach the error callback', async () => {
    await assert.rejects(request('get', '/error'), /HTTP 503:/);
    await assert.rejects(request('get', '/invalid'), /JSON|Unexpected token/);
  });
  await t.test('timeout aborts the request and reaches the error callback', async () => {
    await assert.rejects(request('get', '/slow', { timeout: 30 }), /Request timeout after 30ms/);
  });
});
