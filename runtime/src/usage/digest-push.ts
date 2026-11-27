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

/** 归档统计按使用人聚合：姓名（显示名兜底工号）+ 三档评价 + 没有结论（未归档）计数。 */
export interface DigestFeedbackRank {
  name: string;
  correct: number;
  vague: number;
  failed: number;
  /** 没有结论：该使用人的会话无人归档评价。 */
  unconcluded: number;
  total: number;
  /** 正确/已评价（模糊计为未达标；未评价不进分母），无已评价时为 null。 */
  accuracy: number | null;
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

/** 按使用人聚合（谁提了问题、其会话收到的归档评价分布）；name 兜底工号，再兜底「匿名」。 */
export function rankFeedbackByUser(items: UsageStatsItem[]): DigestFeedbackRank[] {
  const buckets = new Map<string, DigestFeedbackRank>();
  for (const item of items) {
    const label = item.owner_display_name?.trim() || item.owner_subject?.trim() || '匿名';
    const existing = buckets.get(label);
    if (existing) {
      if (item.feedback === 'none') existing.unconcluded += 1;
      else existing[item.feedback] += 1;
      existing.total += 1;
    } else {
      buckets.set(label, {
        name: label,
        correct: item.feedback === 'correct' ? 1 : 0,
        vague: item.feedback === 'vague' ? 1 : 0,
        failed: item.feedback === 'failed' ? 1 : 0,
        unconcluded: item.feedback === 'none' ? 1 : 0,
        total: 1,
        accuracy: null,
      });
    }
  }
  const ranks = [...buckets.values()];
  for (const rank of ranks) {
    const evaluated = rank.correct + rank.vague + rank.failed;
    rank.accuracy = evaluated > 0 ? rank.correct / evaluated : null;
  }
  return ranks.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatAccuracy(accuracy: number | null): string {
  // 没有结论不参与正确率：无已评价会话时显示 —。
  if (accuracy == null) return '—';
  return `${(accuracy * 100).toFixed(1)}%`;
}

function feedbackRowCells(row: { name: string; correct: number; vague: number; failed: number; unconcluded: number; total: number; accuracy: number | null }): string {
  return `| ${escapeCell(row.name)} | ${row.correct} | ${row.vague} | ${row.failed} | ${row.unconcluded} | ${row.total} | ${formatAccuracy(row.accuracy)} |`;
}

const FEEDBACK_TABLE_HEADER = [
  '| 姓名 | 分析正确 | 分析模糊 | 分析失败 | 没有结论 | 合计 | 正确率 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
];

/** Markdown body：归档反馈按人统计（姓名/三档/合计/正确率），头部一行使用量概要。 */
export function buildDigestMarkdown(
  stats: UsageStatsResult,
  pageUrl: string,
): string {
  const ranks = rankFeedbackByUser(stats.items);
  const title = buildDigestTitle(stats.date);
  const heading = `**${title}**`;
  const evaluatedTotal = ranks.reduce((sum, row) => sum + row.correct + row.vague + row.failed, 0);
  const overview = `当日使用 ${stats.summary.unique_users} 人、${stats.summary.conversations} 个会话；归档反馈 ${evaluatedTotal} 条。`;
  const lines: string[] = [heading, '', overview];
  if (ranks.length === 0) {
    lines.push('当日暂无使用记录。');
  } else {
    lines.push(...FEEDBACK_TABLE_HEADER);
    const totals = {
      name: '合计',
      correct: ranks.reduce((sum, row) => sum + row.correct, 0),
      vague: ranks.reduce((sum, row) => sum + row.vague, 0),
      failed: ranks.reduce((sum, row) => sum + row.failed, 0),
      unconcluded: ranks.reduce((sum, row) => sum + row.unconcluded, 0),
      total: ranks.reduce((sum, row) => sum + row.total, 0),
      accuracy: null as number | null,
    };
    totals.accuracy = evaluatedTotal > 0 ? totals.correct / evaluatedTotal : null;
    for (const row of ranks) lines.push(feedbackRowCells(row));
    lines.push(feedbackRowCells(totals));
  }
  // 知音楼 markdown 用 align=right 把「查看详情」放到右下。
  const detailLink = `<div align="right">\n\n[查看详情](${pageUrl})\n\n</div>`;
  lines.push('', detailLink);
  let body = lines.join('\n');
  if (body.length > IM_MESSAGE_LIMIT) {
    const header = [heading, '', overview, ...FEEDBACK_TABLE_HEADER];
    const footer = ['', '…（其余见详情页）', '', detailLink];
    const budget = IM_MESSAGE_LIMIT - footer.join('\n').length - 8;
    const kept: string[] = [...header];
    for (const row of ranks) {
      const cell = feedbackRowCells(row);
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
