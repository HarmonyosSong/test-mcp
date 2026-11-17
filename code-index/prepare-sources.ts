import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GitLabArchiveClient } from '../runtime/src/capabilities/gitlab-archive.js';
import { RepositoryCapability } from '../runtime/src/capabilities/repository.js';
import { VersionRegistry } from '../runtime/src/capabilities/version-registry.js';
import { resolveVersionSource } from '../runtime/src/capabilities/version-source.js';
import { loadRuntimeConfig } from '../runtime/src/config.js';

type Profile = {
  platform: 'harmony' | 'android' | 'ios';
  product_line: 'xueersi' | 'xuejiayun';
  form_factor: 'phone' | 'pad' | 'universal';
  versions: string[];
};

const root = resolve(import.meta.dirname, '..');
const config = loadRuntimeConfig();
if (!config.gitlabToken) throw new Error('未配置 GitLab 凭据，读取 .env 中的 token 后再运行');
const configPath = resolve(root, 'code-index/sources.json');
const { profiles } = JSON.parse(await readFile(configPath, 'utf8')) as { profiles: Profile[] };
const outputDir = resolve(root, '.data/code-index');
const snapshotDir = resolve(outputDir, 'workspaces');
await mkdir(snapshotDir, { recursive: true });
const registry = new VersionRegistry(resolve(root, config.versionRegistryRoot));
await registry.load();
const client = new GitLabArchiveClient({
  baseUrl: config.gitlabBaseUrl,
  token: config.gitlabToken,
  timeoutMs: config.gitlabTimeoutMs,
});
const repositories = new RepositoryCapability({ snapshotDir });
const sources: Record<string, unknown>[] = [];
const failures: Record<string, unknown>[] = [];

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
        failures.push({ key, status: 'exact_version_unavailable', limitations });
        continue;
      }
      const shell = selection.repositories.find((repository) => repository.role === 'shell');
      if (!shell) throw new Error('版本登记中没有 shell 仓库');
      const record = await repositories.ensureRegistryRepository(shell.repository_id, {
        baseUrl: config.gitlabBaseUrl,
        ref: shell.ref,
      });
      let snapshot;
      try {
        snapshot = await repositories.getPreparedSnapshot(record.id, shell.ref, shell.expected_commit);
      } catch {
        const downloaded = await client.downloadArchive(shell.repository_id, shell.expected_commit);
        snapshot = await repositories.prepareArchiveSnapshot(record.id, shell.ref, downloaded.commit.id, downloaded.archive);
      }
      sources.push({
        platform: profile.platform,
        product_line: profile.product_line,
        form_factor: profile.form_factor,
        version,
        build: selection.build.build ?? null,
        repository_id: shell.repository_id,
        ref: shell.ref,
        resolved_commit: shell.expected_commit,
        workspace: snapshot.workspace_path,
        limitations,
      });
      process.stdout.write(`prepared ${key} ${shell.expected_commit.slice(0, 12)}\n`);
    } catch (error) {
      failures.push({ key, status: 'prepare_failed', message: error instanceof Error ? error.message : 'unknown error' });
      process.stderr.write(`failed ${key}\n`);
    }
  }
}

await writeFile(resolve(outputDir, 'sources.json'), `${JSON.stringify({ sources, failures }, null, 2)}\n`, 'utf8');
process.stdout.write(`source manifest: ${sources.length} prepared, ${failures.length} unavailable\n`);
