import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const MAX_FRAME = 256 * 1024;
const AUTH_FAILURE_REASONS = new Set([
  'config', 'checksum', 'sdk_load', 'sdk_init', 'credential', 'timeout',
]);

export interface YachBridgeSettings {
  appKey: string;
  appSecret: string;
  channelAppId: string;
  bizId: string;
  dispatchUrl: string;
  bridgePath: string;
  nodePath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class YachBridge {
  private process: ChildProcess | null = null;
  private closed = false;
  private authenticated = false;
  private failures = 0;

  constructor(private readonly settings: YachBridgeSettings) {}

  async *events(): AsyncGenerator<unknown> {
    while (!this.closed) {
      try {
        await this.start();
        const stdout = this.process?.stdout;
        if (!stdout) break;
        const lines = createInterface({ input: stdout });
        for await (const line of lines) {
          if (this.closed) break;
          if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) throw new Error('oversized bridge frame');
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (!frame || typeof frame !== 'object') throw new Error('invalid bridge frame');
          const kind = frame.type;
          if (kind === 'authenticated') {
            this.authenticated = true;
            this.failures = 0;
          } else if (kind === 'event' && this.authenticated) {
            yield frame.payload;
          } else if (kind === 'oversized') {
            console.warn('Yach bridge dropped an oversized event');
          } else if (kind === 'auth_failed') {
            const reason = typeof frame.reason === 'string' && AUTH_FAILURE_REASONS.has(frame.reason)
              ? frame.reason
              : 'unknown';
            console.warn(`Yach bridge authentication failed: ${reason}`);
            break;
          } else if (kind === 'disconnected') {
            console.warn('Yach bridge disconnected');
            break;
          }
        }
      } catch (error) {
        console.warn('Yach SDK bridge disconnected', error instanceof Error ? error.message : error);
      } finally {
        await this.stopProcess();
      }
      if (!this.closed) {
        const delay = Math.min(5_000 * 2 ** Math.min(this.failures, 6), 300_000);
        this.failures += 1;
        await sleep(delay);
      }
    }
  }

  private async start(): Promise<void> {
    const path = isAbsolute(this.settings.bridgePath)
      ? this.settings.bridgePath
      : resolve(this.settings.bridgePath);
    await access(path, fsConstants.R_OK);
    const env: NodeJS.ProcessEnv = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    const child = spawn(this.settings.nodePath, [path], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    });
    this.process = child;
    this.authenticated = false;
    const config = {
      type: 'configure',
      appKey: this.settings.appKey,
      appSecret: this.settings.appSecret,
      channelAppId: this.settings.channelAppId,
      bizId: String(this.settings.bizId),
      proxyUrl: this.settings.dispatchUrl,
    };
    child.stdin?.write(`${JSON.stringify(config)}\n`);
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.authenticated = false;
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

  async close(): Promise<void> {
    this.closed = true;
    await this.stopProcess();
  }
}
