/**
 * 首次部署/本地运行的源码快照预热：
 * 对 code-index/sources.json 的每个 profile × 版本，按与运行时完全相同的解析链
 * （版本登记 → 壳快照 → iOS/安卓组件物化）把 archive 下载物化到**运行时快照缓存**
 * （HARMONY_MASTRA_SNAPSHOT_DIR，默认 .data/workspaces）。
 *
 * 预热后诊断 prepare_source 直接命中缓存，不再现等 GitLab 下载。
 * 不预热也能跑——首轮每个版本现下载而已；大仓库建议先设
 * HARMONY_AGENT_GITLAB_TIMEOUT_MS=300000。
 *
 * 用法：npx tsx code-index/warm-runtime-cache.ts（或 make bootstrap-sources）
 * 幂等：已物化的快照直接命中跳过，可随时重跑（如版本登记表更新后）。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GitLabArchiveClient } from '../runtime/src/capabilities/gitlab-archive.js';
import { RepositoryCapability } from '../runtime/src/capabilities/repository.js';
import { VersionRegistry } from '../runtime/src/capabilities/version-registry.js';
import { resolveVersionSource } from '../runtime/src/capabilities/version-source.js';
import { materializeComponentSnapshots, resolvePlatformComponents } from '../runtime/src/capabilities/component-resolution.js';
import { loadRuntimeConfig } from '../runtime/src/config.js';

type Profile = {
  platform: 'harmony' | 'android' | 'ios';
  product_line: 'xueersi' | 'xuejiayun';
  form_factor: 'phone' | 'pad' | 'universal';
  versions: string[];
};

const root = resolve(import.meta.dirname, '..');
const config = loadRuntimeConfig();
if (!config.gitlabToken) throw new Error('未配置 GitLab 凭据（.env 的 HARMONY_AGENT_GITLAB_TOKEN 或 ANALYSIS_GIT_TOKEN）');

const { profiles } = JSON.parse(await readFile(resolve(root, 'code-index/sources.json'), 'utf8')) as { profiles: Profile[] };
const registry = new VersionRegistry(resolve(root, config.versionRegistryRoot));
await registry.load();
const client = new GitLabArchiveClient({
  baseUrl: config.gitlabBaseUrl,
  token: config.gitlabToken,
  timeoutMs: config.gitlabTimeoutMs,
});
// 与运行时同一个缓存根：预热产物即诊断现场产物。
const repositories = new RepositoryCapability({ snapshotDir: config.snapshotDir });

let warmed = 0;
const failures: Array<{ key: string; message: string }> = [];

for (const profile of profiles) {
  for (const version of profile.versions) {
    const key = `${profile.platform}/${profile.product_line}/${profile.form_factor}/${version}`;
    try {
      const { selection, limitations } = await resolveVersionSource(registry, client, {
        platform: profile.platform,
        productLine: profile.product_line,
        formFactor: profile.form_factor,
        version,
      });
      if (selection.entry.version !== version) {
        failures.push({ key, message: `精确版本不可用：${limitations.join('；')}` });
        continue;
      }
      const prepareRepository = async (registryRepository: (typeof selection.repositories)[number]) => {
        const record = await repositories.ensureRegistryRepository(registryRepository.repository_id, {
          baseUrl: config.gitlabBaseUrl,
          ref: registryRepository.ref,
        });
        try {
          const snapshot = await repositories.getPreparedSnapshot(record.id, registryRepository.ref, registryRepository.expected_commit);
          return { snapshot, outcome: 'hit' as const };
        } catch {
          const downloaded = await client.downloadArchive(registryRepository.repository_id, registryRepository.expected_commit);
          const snapshot = await repositories.prepareArchiveSnapshot(record.id, registryRepository.ref, downloaded.commit.id, downloaded.archive);
          return { snapshot, outcome: 'downloaded' as const };
        }
      };
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
      warmed += 1;
      process.stdout.write(`warmed ${key} shell=${shellPrepared.outcome} components=${componentRepositories.length}（新下载 ${downloadedCount}）\n`);
    } catch (error) {
      failures.push({ key, message: error instanceof Error ? error.message : 'unknown error' });
      process.stderr.write(`failed ${key}: ${failures.at(-1)!.message}\n`);
    }
  }
}

process.stdout.write(`\nbootstrap: ${warmed} 个版本窗就绪，${failures.length} 个失败\n`);
if (failures.length) {
  for (const failure of failures) process.stdout.write(`  - ${failure.key}: ${failure.message}\n`);
  process.exitCode = 1;
}
