'use strict';
// stdout is a private protocol pipe. No SDK log text or credentials may escape.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
for (const name of ['log', 'debug', 'info', 'warn', 'error', 'trace', 'dir']) {
  console[name] = () => {};
}
const MAX_FRAME = 256 * 1024;
const ALIVE_INTERVAL = 30_000;
const AUTH_FAILURES = new Set(['config', 'checksum', 'sdk_load', 'sdk_init']);
let channel;
let authenticated = false;
let configured = false;
let input = '';
let authTimer;
let aliveTimer;
function emit(frame) {
  const line = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME) {
    // 超限事件不能静默丢弃；用固定小帧通知父进程。
    process.stdout.write(JSON.stringify({ type: 'oversized' }) + '\n');
    return;
  }
  // Exit and reconnect if the parent cannot keep up; never buffer without a bound.
  if (process.stdout.writableLength + Buffer.byteLength(line) > MAX_FRAME * 2) {
    shutdown(1);
    return;
  }
  process.stdout.write(line);
}
function shutdown(code = 0) {
  authenticated = false;
  clearTimeout(authTimer);
  clearInterval(aliveTimer);
  try { if (channel) channel.unInit(); } catch (_) {}
  process.exit(code);
}
function configure(config) {
  if (configured || config.type !== 'configure') throw new Error('config');
  configured = true;
  for (const key of ['appKey', 'appSecret', 'channelAppId', 'bizId', 'proxyUrl']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error('config');
  }
  const endpoint = new URL(config.proxyUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) throw new Error('config');
  const sdkPath = path.join(__dirname, 'vendor', 'tal-msg-sdk.cjs');
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor', 'provenance.json')));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(sdkPath)).digest('hex');
  if (hash !== record.vendored_sha256) throw new Error('checksum');
  let TalMsgClient;
  try { TalMsgClient = require(sdkPath); } catch (_) { throw new Error('sdk_load'); }
  const client = new TalMsgClient(config.channelAppId, '1.0.0');
  client.setSdkConfig({
    proxyConfig: { protocol: 'https', hostname: endpoint.hostname,
      port: Number(endpoint.port || 443), url: endpoint.pathname },
    extra: { location: 'China', logLevel: 'none', logWriter: () => {} },
  });
  channel = client.getInstance(TalMsgClient.CHANNEL);
  channel.on('authResponse', (response) => {
    if (response && response.code === 0) {
      clearTimeout(authTimer);
      authenticated = true;
      emit({ type: 'authenticated' });
      aliveTimer = setInterval(() => emit({ type: 'alive' }), ALIVE_INTERVAL);
    } else {
      emit({ type: 'auth_failed', reason: 'credential' });
      shutdown(1);
    }
  });
  channel.on('recvMsg', (payload) => {
    if (authenticated) emit({ type: 'event', payload });
  });
  channel.on('kickout', () => { emit({ type: 'disconnected' }); shutdown(1); });
  channel.on('netStatusChange', (data) => {
    // CHANNEL's NetStatus$2: DisConnected=1, Connected=2, ReConnecting=3, ReConnected=4.
    // ChannelStatus is a different internal enum and must not be used here.
    if (data && (data.netStatus === 1 || data.netStatus === 3)) {
      emit({ type: 'disconnected' }); shutdown(1);
    }
  });
  authTimer = setTimeout(() => { emit({ type: 'auth_failed', reason: 'timeout' }); shutdown(1); }, 60_000);
  const result = channel.init(config.bizId, { userId: config.appKey,
    auth: { params: new Map([['app_key', config.appKey], ['app_secret', config.appSecret]]) } });
  if (result !== 0) throw new Error('sdk_init');
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  input += data;
  if (Buffer.byteLength(input) > MAX_FRAME) return shutdown(1);
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    try {
      configure(JSON.parse(line));
    } catch (error) {
      emit({
        type: 'auth_failed',
        reason: AUTH_FAILURES.has(error.message) ? error.message : 'config',
      });
      shutdown(1);
    }
  }
});
process.stdin.on('end', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('uncaughtException', () => { emit({ type: 'disconnected' }); shutdown(1); });
process.on('unhandledRejection', () => { emit({ type: 'disconnected' }); shutdown(1); });
process.stdout.on('error', () => shutdown(1));
