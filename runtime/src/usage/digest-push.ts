import { spawn } from 'node:child_process';
import type { RuntimeConfig } from '../config.js';
import { integrationInfo, integrationWarn } from '../observability/integration-log.js';
import { IM_MESSAGE_LIMIT, parseCliJson } from '../channels/yach/cli.js';
import { USAGE_DIGEST_TITLE_PREFIX, USAGE_PAGE_PATH } from './constants.js';
import type { UsageStatsItem, UsageStatsResult } from './types.js';

export interface DigestPushDeps {
  config: Pick<
    RuntimeConfig,
    | 'publicBaseUrl'
    | 'appPrefix'
    | 'yachCliPath'
    | 'yachAppKey'
    | 'yachAppSecret'
    | 'usageDigestGroupId'
  >;
  runCommand?: (
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface DigestUserRank {
  name: string;
  work_code: string;
  count: number;
}

function defaultRunCommand(
  cliPath: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('yach-cli digest push timed out'));
    }, options?.timeoutMs ?? 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
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

/** 知音楼消息标题：问题排查助手每日使用统计(YYYY-MM-DD) */
export function buildDigestTitle(dateYmd: string): string {
  return `${USAGE_DIGEST_TITLE_PREFIX}(${dateYmd})`;
}

export function buildDigestPageUrl(
  config: Pick<RuntimeConfig, 'publicBaseUrl' | 'appPrefix'>,
  dateYmd: string,
): string {
  const base = (config.publicBaseUrl || '').replace(/\/+$/, '');
  const prefix = config.appPrefix || '/xesapp-agent';
  const path = `${prefix}${USAGE_PAGE_PATH}`.replace(/\/{2,}/g, '/');
  if (!base) return `${path}?date=${encodeURIComponent(dateYmd)}`;
  return `${base}${path}?date=${encodeURIComponent(dateYmd)}`;
}

/** Rank users by conversation count (使用次数); name falls back to work code. */
export function rankUsageByUser(items: UsageStatsItem[]): DigestUserRank[] {
  const buckets = new Map<string, DigestUserRank>();
  for (const item of items) {
    const workCode = item.owner_subject?.trim() || '匿名';
    const name = item.owner_display_name?.trim() || workCode;
    const key = item.owner_subject?.trim() || `__anon__:${name}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      // Prefer a real display name if a later item has one.
      if (item.owner_display_name?.trim() && existing.name === existing.work_code) {
        existing.name = item.owner_display_name.trim();
      }
    } else {
      buckets.set(key, { name, work_code: workCode, count: 1 });
    }
  }
  return [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.work_code.localeCompare(b.work_code, 'zh-CN');
  });
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Markdown body: 标题写进正文（知音楼 --title 常只作预览，卡片内不一定显眼）。 */
export function buildDigestMarkdown(
  stats: UsageStatsResult,
  pageUrl: string,
): string {
  const ranks = rankUsageByUser(stats.items);
  const title = buildDigestTitle(stats.date);
  const heading = `**${title}**`;
  const lines: string[] = [heading, ''];
  if (ranks.length === 0) {
    lines.push('当日暂无使用记录。');
  } else {
    lines.push('| 姓名 | 工号 | 使用次数 |');
    lines.push('| --- | --- | ---: |');
    for (const row of ranks) {
      lines.push(
        `| ${escapeCell(row.name)} | ${escapeCell(row.work_code)} | ${row.count} |`,
      );
    }
  }
  // 知音楼 markdown 用 align=right 把「查看详情」放到右下。
  const detailLink = `<div align="right">\n\n[查看详情](${pageUrl})\n\n</div>`;
  lines.push('', detailLink);
  let body = lines.join('\n');
  if (body.length > IM_MESSAGE_LIMIT) {
    const header = [
      heading,
      '',
      '| 姓名 | 工号 | 使用次数 |',
      '| --- | --- | ---: |',
    ];
    const footer = ['', '…（其余见详情页）', '', detailLink];
    const budget = IM_MESSAGE_LIMIT - footer.join('\n').length - 8;
    const kept: string[] = [...header];
    for (const row of ranks) {
      const cell = `| ${escapeCell(row.name)} | ${escapeCell(row.work_code)} | ${row.count} |`;
      if (kept.join('\n').length + cell.length + 1 > budget) break;
      kept.push(cell);
    }
    body = [...kept, ...footer].join('\n');
  }
  return body;
}

/** Push daily stats as a Yach markdown table message. */
export async function pushUsageDigest(
  stats: UsageStatsResult,
  deps: DigestPushDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const groupId = deps.config.usageDigestGroupId.trim();
  if (!groupId) {
    return { ok: false, reason: 'usage digest group id empty' };
  }
  if (!deps.config.publicBaseUrl.trim()) {
    integrationWarn('usage', 'digest skipped: PUBLIC_BASE_URL empty');
    return { ok: false, reason: 'publicBaseUrl empty' };
  }

  const title = buildDigestTitle(stats.date);
  const pageUrl = buildDigestPageUrl(deps.config, stats.date);
  const markdown = buildDigestMarkdown(stats, pageUrl);
  const args = [
    'im',
    'send',
    '--robot',
    '--group-id',
    groupId,
    '--title',
    title,
    '--markdown',
    markdown,
  ];

  const run = deps.runCommand
    ?? ((cmdArgs, options) => defaultRunCommand(deps.config.yachCliPath, cmdArgs, options));

  try {
    if (deps.config.yachAppKey && deps.config.yachAppSecret) {
      await run([
        'config',
        'init',
        '--app-key',
        deps.config.yachAppKey,
        '--app-secret',
        deps.config.yachAppSecret,
      ], { timeoutMs: 20_000 }).catch(() => undefined);
    }
    const result = await run(args, { timeoutMs: 30_000 });
    const payload = parseCliJson(result.stdout || result.stderr);
    if (payload.ok === false || (result.code !== 0 && payload.ok !== true)) {
      integrationWarn('usage', 'digest push failed', { code: result.code, date: stats.date });
      return { ok: false, reason: 'yach-cli im send failed' };
    }
    integrationInfo('usage', 'digest pushed', {
      date: stats.date,
      groupId,
      uniqueUsers: stats.summary.unique_users,
    });
    return { ok: true };
  } catch (error) {
    integrationWarn('usage', 'digest push error', {
      date: stats.date,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
