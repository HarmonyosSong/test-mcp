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

test('鸿蒙未登记版本按精确 tag 解析；不存在、无凭据或构建不匹配时不换成新版', async () => {
  await withRegistry(async (registry) => {
    await mkdir(join(registry.root, 'harmony'));
    await writeFile(join(registry.root, 'harmony/xueersi.yaml'), JSON.stringify([{
      version: '7.106.0', form_factor: 'universal', builds: [{
        tag: '7.106.0', source: 'tag-scan', verified: true,
        repos: [
          { repository_id: 'group/harmony', role: 'shell', ref: '7.106.0', expected_commit: 'a'.repeat(40) },
          { repository_id: 'group/component', role: 'component', mount_path: 'Modules', ref: 'new', expected_commit: 'c'.repeat(40) },
        ],
      }],
    }]));
    await registry.load();
    const input = { platform: 'harmony' as const, productLine: 'xueersi' as const, version: '7.105.0' };
    let status = 200;
    let requests = 0;
    const client = new GitLabArchiveClient({
      baseUrl: 'https://git.example.test', token: 'fixture',
      fetchImpl: async (url) => {
        requests++;
        assert.equal(new URL(String(url)).pathname, '/api/v4/projects/group%2Fharmony/repository/tags/7.105.0');
        return status === 200 ? Response.json({ name: '7.105.0', commit: { id: COMMIT } }) : new Response('', { status });
      },
    });
    const exact = await resolveVersionSource(registry, client, input);
    assert.equal(exact.selection.entry.version, '7.105.0');
    assert.equal(exact.selection.repositories[0]?.ref, '7.105.0');
    assert.equal(exact.selection.repositories[0]?.expected_commit, COMMIT);
    assert.equal(exact.selection.repositories.length, 1);
    assert.deepEqual(exact.limitations, []);
    await resolveVersionSource(registry, client, { ...input, version: '7.106.0' });
    assert.equal(requests, 1, 'registered releases do not need tag discovery');
    await assert.rejects(() => resolveVersionSource(registry, null, input), /HARMONY_AGENT_GITLAB_TOKEN.*未改用其它版本/);
    await assert.rejects(() => resolveVersionSource(registry, client, { ...input, build: '123' }), /无法核实指定构建/);
    assert.equal(requests, 1);
    status = 404;
    await assert.rejects(() => resolveVersionSource(registry, client, input), /没有鸿蒙 7\.105\.0 的精确发布 tag/);
    status = 403;
    await assert.rejects(() => resolveVersionSource(registry, client, input), /HTTP 403/);
  });
});

test('安卓按精确版本和构建查询，按实际 tag 区分手机/平板，不继承新版组件', async () => {
  await withRegistry(async (registry) => {
    await mkdir(join(registry.root, 'android'));
    for (const product of ['xueersi', 'xuejiayun']) {
      await writeFile(join(registry.root, `android/${product}.yaml`), JSON.stringify(['phone', 'pad'].map((form) => ({
        version: form === 'phone' ? '7.106.0' : '5.106.0', form_factor: form, builds: [{
          build: '99', tag: 'V7.106.0-99-TEST', source: 'tag-scan', verified: true,
          repos: [
            { repository_id: `${product}/${form}`, role: 'shell', ref: 'new', expected_commit: 'a'.repeat(40) },
            { repository_id: 'group/component', role: 'component', mount_path: 'Modules', ref: 'new', expected_commit: 'c'.repeat(40) },
          ],
        }],
      }))));
    }
    await registry.load();
    let conflicting = false;
    let forbiddenPad = false;
    const requested: string[] = [];
    const client = new GitLabArchiveClient({
      baseUrl: 'https://git.example.test', token: 'fixture',
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const repo = decodeURIComponent(url.pathname.split('/projects/')[1]!.split('/repository/')[0]!);
        const version = url.searchParams.get('search');
        requested.push(repo);
        if (forbiddenPad && repo.endsWith('/pad')) return new Response('', { status: 403 });
        if (repo.endsWith('/pad')) return Response.json(version === '5.105.0'
          ? [{ name: 'V5.105.0-12-TEST', commit: { id: COMMIT } }] : []);
        return Response.json([
          { name: 'V7.105.0-9-TEST', commit: { id: 'd'.repeat(40) } },
          { name: 'V7.105.0-10-CUSTOM', commit: { id: COMMIT } },
          { name: 'V7.105.0-10-TEST', commit: { id: conflicting ? 'e'.repeat(40) : COMMIT } },
          { name: 'V7.105.01-999-TEST', commit: { id: COMMIT } },
          { name: 'login-V7.105.0-999-CUSTOM', commit: { id: COMMIT } },
          { name: 'V7.105.0-999-CUSTOM-debug', commit: { id: COMMIT } },
        ]);
      },
    });
    const input = { platform: 'android' as const, productLine: 'xueersi' as const, version: '7.105.0' };
    const latest = await resolveVersionSource(registry, client, input);
    assert.equal(latest.selection.entry.form_factor, 'phone');
    assert.equal(latest.selection.entry.version, '7.105.0');
    assert.equal(latest.selection.build.build, '10');
    assert.equal(latest.selection.repositories[0]?.expected_commit, COMMIT);
    assert.equal(latest.selection.repositories.length, 1);
    assert.match(latest.limitations.join(), /未提供现场构建号.*尚未确认/);
    assert.deepEqual(new Set(requested), new Set(['xueersi/phone', 'xueersi/pad']));
    requested.length = 0;
    const exact = await resolveVersionSource(registry, client, { ...input, build: '9', formFactor: 'phone' });
    assert.equal(exact.selection.build.build, '9');
    assert.deepEqual(exact.limitations, []);
    assert.deepEqual(requested, ['xueersi/phone']);
    const pad = await resolveVersionSource(registry, client, { ...input, version: '5.105.0' });
    assert.equal(pad.selection.entry.form_factor, 'pad');
    assert.equal(pad.selection.repositories[0]?.repository_id, 'xueersi/pad');
    await assert.rejects(() => resolveVersionSource(registry, client, { ...input, productLine: undefined }), /多个产品线/);
    await assert.rejects(() => resolveVersionSource(registry, client, { ...input, build: '999' }), /没有 7\.105\.0 build 999.*未改用/);
    await assert.rejects(() => resolveVersionSource(registry, client, { ...input, version: '7.104.0' }), /没有 7\.104\.0.*未改用/);
    await assert.rejects(() => resolveVersionSource(registry, null, input), /HARMONY_AGENT_GITLAB_TOKEN.*未改用/);
    conflicting = true;
    await assert.rejects(() => resolveVersionSource(registry, client, input), /多个类型 tag 指向不同 commit/);
    conflicting = false;
    forbiddenPad = true;
    await assert.rejects(() => resolveVersionSource(registry, client, input), /HTTP 403/);
  });
});
