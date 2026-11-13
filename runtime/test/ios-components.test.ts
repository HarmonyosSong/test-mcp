import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitLabArchiveClient } from '../src/capabilities/gitlab-archive.js';
import { parseIosDependencies, resolveIosComponents, type IosComponentRules } from '../src/capabilities/ios-components.js';

const RULES: IosComponentRules = [{ prefix: 'XesApp', namespace: 'group/ios', suffix: 'Code' }];
const SHA = 'a'.repeat(40);

test('Podfile 字面声明合并本地 helper，忽略注释和动态 Ruby，不把声明当作锁定', () => {
  const dependencies = parseIosDependencies(`
XesAppBase_Pod=0
if XesAppBase_Pod == 0
  pod_xesapp 'XesAppJSBridge'
else
  pod 'XesAppJSBridge', '3.4.4'
end
# pod 'XesAppJSBridge', '9.9.9'
pod_framework 'XesAppKit','2.6.34' # :git => 'https://bad.test/repo', :branch => 'main'
pod 'TALPlayerMiddleware', :path => '../../OtherModules/player'
pod "#{name}", "#{version}"
=begin
pod 'XesAppJSBridge', '8.8.8'
=end
system('must never execute')
`);
  assert.deepEqual(dependencies.map(({ name, version, basis }) => ({ name, version, basis })), [
    { name: 'XesAppJSBridge', version: '3.4.4', basis: 'podfile-declaration' },
    { name: 'XesAppKit', version: '2.6.34', basis: 'podfile-declaration' },
    { name: 'TALPlayerMiddleware', version: null, basis: 'podfile-declaration' },
  ]);
  assert.equal(dependencies[1]?.git, undefined);
  assert.equal(dependencies[1]?.conflict, undefined);
});

test('Podfile.lock 优先于声明版本，折叠 subspec 并读取精确 checkout SHA', () => {
  const deps = parseIosDependencies("pod 'XesAppJSBridge', '9.0.0'", `
PODS:
  - XesAppJSBridge (3.4.4)
  - XesAppJSBridge/Core (3.4.4):
    - XesAppKit
  - XesAppKit (2.6.34)
EXTERNAL SOURCES:
  XesAppKit:
    :git: https://git.example.test/group/Kit.git
    :branch: release
CHECKOUT OPTIONS:
  XesAppKit:
    :commit: ${SHA}
`);
  assert.equal(deps.length, 2);
  assert.equal(deps[0]?.version, '3.4.4');
  assert.equal(deps[0]?.basis, 'lockfile');
  assert.equal(deps[1]?.commit, SHA);
  assert.notEqual(deps[1]?.conflict, true);
});

async function workspace(podfile: string, run: (path: string) => Promise<void>, lockfile?: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ios-components-'));
  try {
    await mkdir(join(root, 'App'));
    await writeFile(join(root, 'App', 'Podfile'), podfile);
    if (lockfile !== undefined) await writeFile(join(root, 'App', 'Podfile.lock'), lockfile);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('动态绑定源码仓精确 tag；缺失组件隔离；不请求 latest 或 Framework 仓', async () => {
  await workspace("pod 'XesAppJSBridge', '3.4.4'\npod 'XesAppMissing', '1.0.0'\npod_other 'TALPlayer'", async (path) => {
    const urls: string[] = [];
    const client = new GitLabArchiveClient({ baseUrl: 'https://git.example.test', token: 'fixture', fetchImpl: async (input) => {
      const url = String(input); urls.push(url);
      return url.includes('XesAppJSBridgeCode') ? Response.json({ name: '3.4.4', commit: { id: SHA } }) : new Response('', { status: 404 });
    } });
    const result = await resolveIosComponents({ workspacePath: path, client, gitlabBaseUrl: 'https://git.example.test', rules: RULES });
    assert.deepEqual(result.repositories, [{ repository_id: 'group/ios/XesAppJSBridgeCode', role: 'component', ref: '3.4.4', expected_commit: SHA, mount_path: 'components/XesAppJSBridge' }]);
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /repository\/tags\/3\.4\.4$/);
    assert.match(result.limitations.join(), /仅供实现对照/);
    assert.match(result.limitations.join(), /XesAppMissing/);
    assert.match(result.limitations.join(), /TALPlayer/);
  });
});

test('冲突版本、无固定版本和非 GitLab 地址保持缺口，不调用网络', async () => {
  await workspace(`
pod 'XesAppA', '1.0.0'
pod 'XesAppA', '2.0.0'
pod_xesapp 'XesAppLocal'
pod 'Other', :git => 'https://elsewhere.test/repo.git', :tag => '1.0.0'
`, async (path) => {
    const client = new GitLabArchiveClient({ baseUrl: 'https://git.example.test', token: 'fixture', fetchImpl: async () => { throw new Error('network must not run'); } });
    const result = await resolveIosComponents({ workspacePath: path, client, gitlabBaseUrl: 'https://git.example.test', rules: RULES });
    assert.deepEqual(result.repositories, []);
    assert.match(result.limitations.join(), /版本冲突/);
    assert.match(result.limitations.join(), /缺少固定版本/);
    assert.match(result.limitations.join(), /不是配置的 GitLab/);
  });
});

test('锁文件中的 git+commit 可解析未配置命名映射的组件，版本错误时不回退 Podfile', async () => {
  await workspace('', async (path) => {
    const client = new GitLabArchiveClient({ baseUrl: 'https://git.example.test', token: 'fixture', fetchImpl: async () => { throw new Error('tag query must not run'); } });
    const result = await resolveIosComponents({ workspacePath: path, client, gitlabBaseUrl: 'https://git.example.test', rules: [] });
    assert.equal(result.repositories[0]?.repository_id, 'group/player');
    assert.equal(result.repositories[0]?.expected_commit, SHA);
    assert.deepEqual(result.limitations, []);
  }, `PODS:\n  - Player (1.0.0)\nCHECKOUT OPTIONS:\n  Player:\n    :git: git@git.example.test:group/player.git\n    :commit: ${SHA}\n`);
  assert.throws(() => parseIosDependencies("pod 'XesAppA', '1.0.0'", 'PODS: invalid'), /PODS/);
});

test('组件数量受限，取消信号不中途转为成功', async () => {
  await workspace("pod 'XesAppA', '1.0.0'\npod 'XesAppB', '1.0.0'", async (path) => {
    let requests = 0;
    const client = new GitLabArchiveClient({ baseUrl: 'https://git.example.test', token: 'fixture', fetchImpl: async () => { requests++; return Response.json({ name: '1.0.0', commit: { id: SHA } }); } });
    const result = await resolveIosComponents({ workspacePath: path, client, gitlabBaseUrl: 'https://git.example.test', rules: RULES, maxComponents: 1 });
    assert.equal(requests, 1);
    assert.match(result.limitations.join(), /超过本轮上限/);
    await assert.rejects(() => resolveIosComponents({ workspacePath: path, client, gitlabBaseUrl: 'https://git.example.test', rules: RULES, signal: AbortSignal.abort() }), /abort/i);
  });
});
