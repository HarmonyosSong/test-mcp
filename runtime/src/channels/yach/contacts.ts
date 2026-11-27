import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { parseCliJson } from './cli.js';

/**
 * 知音楼通讯录工号 → 姓名解析（contacts get）。
 * 用于统计/日报把 owner_subject 工号翻译成姓名；磁盘缓存，姓名变更概率极低不设过期。
 * 任何失败（cli 缺席、查不到、超时）都返回 null，调用方兜底显示工号。
 */

export interface ContactResolver {
  resolveNames(workCodes: string[]): Promise<Map<string, string>>;
}

type CacheData = Record<string, string>;

async function loadCache(cachePath: string): Promise<CacheData> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CacheData;
    }
  } catch {
    // 缓存缺失/损坏都从空开始
  }
  return {};
}

async function saveCache(cachePath: string, cache: CacheData): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, cachePath);
}

/** 从 contacts get 输出提取姓名；查不到/格式异常返回 null。 */
function extractName(stdout: string): string | null {
  try {
    const payload = parseCliJson(stdout);
    if (payload.ok !== true) return null;
    const data = payload.data as { obj?: { name?: unknown } } | undefined;
    const name = data?.obj?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

function queryName(cliPath: string, workCode: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, ['contacts', 'get', '--work-code', workCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? extractName(stdout) : null);
    });
  });
}

export function createYachContactResolver(options: {
  cliPath: string;
  cachePath: string;
  timeoutMs?: number;
}): ContactResolver {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async resolveNames(workCodes) {
      const unique = [...new Set(workCodes.map((code) => code.trim()).filter(Boolean))];
      const result = new Map<string, string>();
      if (unique.length === 0) return result;

      const cache = await loadCache(options.cachePath);
      const missing: string[] = [];
      for (const code of unique) {
        const cached = cache[code];
        if (cached) result.set(code, cached);
        else missing.push(code);
      }
      // 串行查询：日报/统计页低频场景，避免打通讯录接口的限流。
      let dirty = false;
      for (const code of missing) {
        const name = await queryName(options.cliPath, code, timeoutMs);
        if (name) {
          cache[code] = name;
          result.set(code, name);
          dirty = true;
        }
      }
      if (dirty) await saveCache(options.cachePath, cache).catch(() => undefined);
      return result;
    },
  };
}
