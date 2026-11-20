/**
 * 生产 pod 源码快照预热（仅依赖 runtime/dist，不需要 runtime/src / tsx）。
 *
 * 前置：在项目根（通常 /app）已有
 *   code-index/sources.json、version-registry/、runtime/{contracts,dist,package.json}
 *   以及 .env 中的 GitLab token；持久卷 HARMONY_AGENT_DATA_ROOT（默认写到其下 workspaces）
 *
 * 用法：
 *   HARMONY_AGENT_GITLAB_TIMEOUT_MS=300000 node code-index/warm-runtime-cache.mjs
 *
 * 并发（默认 = CPU 核数，上限 8；可按机器/GitLab 限流调整）：
 *   HARMONY_AGENT_BOOTSTRAP_CONCURRENCY=4 node code-index/warm-runtime-cache.mjs
 *
 * 说明：Node 主线程仍是单线程，但多版本窗并行会重叠 GitLab 下载与解压 I/O，
 * 解压等原生工作会用到多核；这比串行墙钟时间快很多。
 */
import { cpus } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitLabArchiveClient } from '../runtime/dist/src/capabilities/gitlab-archive.js';
import { RepositoryCapability } from '../runtime/dist/src/capabilities/repository.js';
import { VersionRegistry } from '../runtime/dist/src/capabilities/version-registry.js';
import { resolveVersionSource } from '../runtime/dist/src/capabilities/version-source.js';
import { materializeComponentSnapshots, resolvePlatformComponents } from '../runtime/dist/src/capabilities/component-resolution.js';
import { loadRuntimeConfig } from '../runtime/dist/src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadRuntimeConfig();
if (!config.gitlabToken) {
  throw new Error('未配置 GitLab 凭据（.env 的 HARMONY_AGENT_GITLAB_TOKEN 或 ANALYSIS_GIT_TOKEN）');
}

const concurrency = Math.max(
  1,
  Math.min(
    8,
    Number.parseInt(process.env.HARMONY_AGENT_BOOTSTRAP_CONCURRENCY || '', 10) || cpus().length || 4,
  ),
);

const { profiles } = JSON.parse(await readFile(resolve(root, 'code-index/sources.json'), 'utf8'));
const registry = new VersionRegistry(resolve(root, config.versionRegistryRoot));
await registry.load();
const client = new GitLabArchiveClient({
  baseUrl: config.gitlabBaseUrl,
  token: config.gitlabToken,
  timeoutMs: config.gitlabTimeoutMs,
});
const repositories = new RepositoryCapability({ snapshotDir: config.snapshotDir });

/** 同仓同 commit 只物化一次，避免并发互相踩。 */
const prepareInflight = new Map();

async function prepareRepository(registryRepository) {
  const dedupeKey = `${registryRepository.repository_id}@${registryRepository.expected_commit}`;
  const existing = prepareInflight.get(dedupeKey);
  if (existing) return existing;

  const task = (async () => {
    const record = await repositories.ensureRegistryRepository(registryRepository.repository_id, {
      baseUrl: config.gitlabBaseUrl,
      ref: registryRepository.ref,
    });
    try {
      const snapshot = await repositories.getPreparedSnapshot(record.id, registryRepository.ref, registryRepository.expected_commit);
      return { snapshot, outcome: 'hit' };
    } catch {
      const downloaded = await client.downloadArchive(registryRepository.repository_id, registryRepository.expected_commit);
      const snapshot = await repositories.prepareArchiveSnapshot(record.id, registryRepository.ref, downloaded.commit.id, downloaded.archive);
      return { snapshot, outcome: 'downloaded' };
    }
  })();

  prepareInflight.set(dedupeKey, task);
  try {
    return await task;
  } finally {
    prepareInflight.delete(dedupeKey);
  }
}

async function warmOne(profile, version) {
  const key = `${profile.platform}/${profile.product_line}/${profile.form_factor}/${version}`;
  const { selection, limitations } = await resolveVersionSource(registry, client, {
    platform: profile.platform,
    productLine: profile.product_line,
    formFactor: profile.form_factor,
    version,
  });
  if (selection.entry.version !== version) {
    return { ok: false, key, message: `精确版本不可用：${limitations.join('；')}` };
  }
  const shell = selection.repositories.find((repository) => repository.role === 'shell');
  if (!shell) throw new Error('版本登记中没有 shell 仓库');
  const shellPrepared = await prepareRepository(shell);
  const { componentRepositories } = await resolvePlatformComponents({
    platform: profile.platform,
    shellWorkspacePath: shellPrepared.snapshot.workspace_path,
    selectionRepositories: selection.repositories,
    client,
    gitlabBaseUrl: config.gitlabBaseUrl,
    contractsDir: resolve(root, 'runtime/contracts'),
  });
  const materialized = await materializeComponentSnapshots({ componentRepositories, prepareRepository });
  const downloadedCount = [shellPrepared, ...materialized.snapshots].filter((item) => item.outcome === 'downloaded').length;
  return {
    ok: true,
    key,
    line: `warmed ${key} shell=${shellPrepared.outcome} components=${componentRepositories.length}（新下载 ${downloadedCount}）`,
  };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

const jobs = profiles.flatMap((profile) => profile.versions.map((version) => ({ profile, version })));
process.stdout.write(`bootstrap: ${jobs.length} 个版本窗，并发 ${concurrency}\n`);

const outcomes = await mapPool(jobs, concurrency, async ({ profile, version }) => {
  const key = `${profile.platform}/${profile.product_line}/${profile.form_factor}/${version}`;
  try {
    const result = await warmOne(profile, version);
    if (result.ok) process.stdout.write(`${result.line}\n`);
    else process.stderr.write(`failed ${result.key}: ${result.message}\n`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`failed ${key}: ${message}\n`);
    return { ok: false, key, message };
  }
});

const warmed = outcomes.filter((item) => item.ok).length;
const failures = outcomes.filter((item) => !item.ok);
process.stdout.write(`\nbootstrap: ${warmed} 个版本窗就绪，${failures.length} 个失败\n`);
if (failures.length) {
  for (const failure of failures) process.stdout.write(`  - ${failure.key}: ${failure.message}\n`);
  process.exitCode = 1;
}
