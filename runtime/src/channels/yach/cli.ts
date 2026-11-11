/** Process wrapper for official yach-cli (config / event / im). */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export const IM_MESSAGE_LIMIT = 4000;

export class YachCliError extends Error {
  constructor(message = 'yach-cli request failed') {
    super(message);
    this.name = 'YachCliError';
  }
}

export interface YachCliSettings {
  cliPath: string;
  appKey: string;
  appSecret: string;
  eventType?: string;
  runCommand?: (
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  spawnEvent?: (args: string[]) => ChildProcess;
}

export interface YachSendTarget {
  toId: string;
  conversationType: '1' | '2';
}

type JsonObject = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer the last JSON object line from CLI stdout/stderr. */
export function parseCliJson(stdout: string): JsonObject {
  const text = stdout.trim();
  if (!text) throw new YachCliError('yach-cli returned empty output');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let last: JsonObject | null = null;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        last = value as JsonObject;
      }
    } catch {
      // ignore non-JSON noise
    }
  }
  if (!last) throw new YachCliError('yach-cli returned non-JSON output');
  return last;
}

/**
 * yach-cli wraps platform JSON as `{ ok, data: { code, msg, obj } }`.
 * `obj` may be a list (robot-groups) or `{ messages: [...] }` (im history).
 */
export function extractList(payload: JsonObject): unknown[] {
  if (payload.ok === false) {
    const err = payload.error;
    const hint = err && typeof err === 'object' && typeof (err as JsonObject).message === 'string'
      ? String((err as JsonObject).message)
      : 'yach-cli command failed';
    throw new YachCliError(hint);
  }
  let node: unknown = payload.data ?? payload;
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const envelope = node as JsonObject;
    if (typeof envelope.code === 'number' && envelope.code !== 200) {
      const msg = typeof envelope.msg === 'string' && envelope.msg ? envelope.msg : `platform code ${envelope.code}`;
      throw new YachCliError(msg);
    }
    if ('obj' in envelope) node = envelope.obj;
  }
  if (Array.isArray(node)) return node;
  if (node && typeof node === 'object') {
    const record = node as JsonObject;
    for (const key of ['messages', 'list', 'items', 'records', 'groups']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

export class YachCli {
  private process: ChildProcess | null = null;
  private closed = false;
  private failures = 0;
  private configured = false;
  private readonly eventType: string;
  private readonly runCommand: NonNullable<YachCliSettings['runCommand']>;
  private readonly spawnEvent: NonNullable<YachCliSettings['spawnEvent']>;

  constructor(private readonly settings: YachCliSettings) {
    this.eventType = settings.eventType?.trim() || 'im.message.receive';
    this.runCommand = settings.runCommand ?? ((args, options) => this.exec(args, options));
    this.spawnEvent = settings.spawnEvent ?? ((args) => this.spawnConsume(args));
  }

  async ensureConfigured(): Promise<void> {
    if (this.configured) return;
    const result = await this.runCommand([
      'config',
      'init',
      '--app_key',
      this.settings.appKey,
      '--app_secret',
      this.settings.appSecret,
    ], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new YachCliError('yach-cli config init failed');
    }
    this.configured = true;
  }

  async *events(): AsyncGenerator<unknown> {
    while (!this.closed) {
      try {
        await this.ensureConfigured();
        const child = this.spawnEvent([
          'event',
          'consume',
          '--event-type',
          this.eventType,
        ]);
        this.process = child;
        this.failures = 0;
        const stdout = child.stdout;
        if (!stdout) break;
        const lines = createInterface({ input: stdout });
        for await (const line of lines) {
          if (this.closed) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            yield JSON.parse(trimmed) as unknown;
          } catch {
            // skip malformed lines
          }
        }
      } catch (error) {
        console.warn('Yach CLI event stream failed', error instanceof Error ? error.message : error);
      } finally {
        await this.stopConsume();
      }
      if (!this.closed) {
        const delay = Math.min(5_000 * 2 ** Math.min(this.failures, 6), 300_000);
        this.failures += 1;
        await sleep(delay);
      }
    }
  }

  async sendMarkdown(target: YachSendTarget, text: string, title = '诊断助手'): Promise<void> {
    if (text.length > IM_MESSAGE_LIMIT) throw new Error('Yach message exceeds single-message limit');
    await this.ensureConfigured();
    const args = ['im', 'send', '--robot', '--title', title, '--markdown', text];
    if (target.conversationType === '2') {
      args.push('--group-id', target.toId);
    } else {
      args.push('--to', target.toId);
    }
    const result = await this.runCommand(args, { timeoutMs: 30_000 });
    const payload = parseCliJson(result.stdout || result.stderr);
    if (payload.ok === false || (result.code !== 0 && payload.ok !== true)) {
      throw new YachCliError('yach-cli im send failed');
    }
  }

  async groupHistory(groupId: string): Promise<unknown[]> {
    await this.ensureConfigured();
    const end = Math.floor(Date.now() / 1000);
    const start = end - 24 * 60 * 60;
    const result = await this.runCommand([
      'im',
      'history',
      '--group-id',
      groupId,
      '--start-time',
      String(start),
      '--end-time',
      String(end),
      '--page-size',
      '100',
    ], { timeoutMs: 30_000 });
    return extractList(parseCliJson(result.stdout || result.stderr));
  }

  async robotGroups(): Promise<unknown[]> {
    await this.ensureConfigured();
    const result = await this.runCommand(['im', 'robot-groups'], { timeoutMs: 30_000 });
    return extractList(parseCliJson(result.stdout || result.stderr));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopConsume();
    try {
      await this.runCommand(['event', 'stop'], { timeoutMs: 15_000 });
    } catch {
      // best-effort Bus cleanup
    }
  }

  private spawnConsume(args: string[]): ChildProcess {
    const child = spawn(this.settings.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.childEnv(),
    });
    // Keep stdin open so consume does not exit on EOF.
    child.stdin?.write('');
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn('[yach-cli event]', text.slice(0, 500));
    });
    return child;
  }

  private async stopConsume(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(5_000).then(() => {
          child.kill('SIGKILL');
        }),
      ]);
    }
    child.stdin?.destroy();
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    return env;
  }

  private exec(
    args: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const child = spawn(this.settings.cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.childEnv(),
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new YachCliError('yach-cli timed out'));
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 2 * 1024 * 1024) {
          child.kill('SIGKILL');
          reject(new YachCliError('yach-cli stdout exceeded'));
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  }
}
