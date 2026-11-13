import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitLabArchiveClient } from '../src/capabilities/gitlab-archive.js';
import { VersionRegistry } from '../src/capabilities/version-registry.js';
import { resolveVersionSource } from '../src/capabilities/version-source.js';

const COMMIT = 'b'.repeat(40);
const INPUT = { platform: 'ios' as const, productLine: 'xuejiayun' as const, formFactor: 'pad' as const, version: '5.105.0' };

async function withRegistry(run: (registry: VersionRegistry) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'version-discovery-'));
  try {
    await mkdir(join(root, 'ios'));
    await writeFile(join(root, 'ios/xuejiayun.yaml'), JSON.stringify([{
      version: '5.106.0', form_factor: 'universal', builds: [{
        build: '1', tag: 'XesAppHD_v5.106.0_1_20261105', source: 'manual', verified: true,
        repos: [
          { repository_id: 'group/ios', role: 'shell', ref: 'XesAppHD_v5.106.0_1_20261105', expected_commit: 'a'.repeat(40) },
          { repository_id: 'group/component', role: 'component', mount_path: 'Modules', ref: 'new-component', expected_commit: 'c'.repeat(40) },
        ],
      }],
    }]));
    const registry = new VersionRegistry(root);
    await registry.load();
    await run(registry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('未登记 iOS 版本动态匹配精确 tag，不借用其它版本组件；显式 build 生效', async () => {
  await withRegistry(async (registry) => {
    const client = new GitLabArchiveClient({
      baseUrl: 'https://git.example.test', token: 'fixture',
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.searchParams.get('search'), '5.105.0');
        assert.match(url.pathname, /group%2Fios\/repository\/tags$/);
        return Response.json([
          { name: 'XesAppHD_v5.105.0_1_20260922', commit: { id: COMMIT } },
          { name: 'XesAppHD_v5.105.0_2_20260923', commit: { id: 'd'.repeat(40) } },
          { name: 'XesAppHD_v5.105.0_99_20260923_debug', commit: { id: 'e'.repeat(40) } },
          { name: 'XesApp_v5.105.0_99_20260923', commit: { id: 'e'.repeat(40) } },
          { name: 'XesAppHD_v5.105.01_99_20260923', commit: { id: 'e'.repeat(40) } },
        ]);
      },
    });
    const latest = await resolveVersionSource(registry, client, INPUT);
    assert.equal(latest.selection.build.build, '2');
    const exact = await resolveVersionSource(registry, client, { ...INPUT, build: '1' });
    assert.equal(exact.selection.entry.version, '5.105.0');
    assert.equal(exact.selection.repositories[0]?.expected_commit, COMMIT);
    assert.equal(exact.selection.repositories.length, 1);
    assert.deepEqual(exact.limitations, []);
    assert.equal(registry.entries().length, 1);
    assert.equal(registry.entries()[0]?.version, '5.106.0');
  });
});

test('已登记版本不额外查 tag；未命中和无凭据的降级保留具体原因', async () => {
  await withRegistry(async (registry) => {
    let requests = 0;
    const client = new GitLabArchiveClient({
      baseUrl: 'https://git.example.test', token: 'fixture',
      fetchImpl: async () => { requests += 1; return Response.json([]); },
    });
    const registered = await resolveVersionSource(registry, client, { ...INPUT, version: '5.106.0' });
    assert.deepEqual(registered.limitations, []);
    assert.equal(requests, 0);
    const absent = await resolveVersionSource(registry, client, INPUT);
    assert.match(absent.limitations.join(), /没有匹配的发布 tag.*5\.106\.0/);
    const missingBuild = await resolveVersionSource(registry, client, { ...INPUT, version: '5.106.0', build: '9' });
    assert.match(missingBuild.limitations.join(), /build 9.*build 1/);
    const offline = await resolveVersionSource(registry, null, INPUT);
    assert.match(offline.limitations.join(), /未配置 GitLab API 凭据/);
  });
});

test('GitLab 鉴权失败不伪装成版本未登记，也不静默改用其它版本', async () => {
  await withRegistry(async (registry) => {
    const client = new GitLabArchiveClient({
      baseUrl: 'https://git.example.test', token: 'fixture',
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    await assert.rejects(() => resolveVersionSource(registry, client, INPUT), /HTTP 403/);
  });
});
