import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntimeApp } from '../src/app.js';
import { loadTestConfig } from './auth-helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

for (const dynamicIos of [false, true]) {
test(dynamicIos ? '未登记 iOS 5.105.0 通过真实绑定路径查询 tag、下载固定快照并保留现场版本' : '创建精确版本会话时选择登记 commit、下载 GitLab archive 并绑定固定快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'version-source-integration-'));
  const source = join(root, 'source');
  const archivePath = join(root, 'archive.tar.gz');
  const registry = join(root, 'version-registry');
  await execFileSync('git', ['init', '-b', 'main', source]);
  git(source, 'config', 'user.email', 'fixture@example.test');
  git(source, 'config', 'user.name', 'Fixture');
  await writeFile(join(source, 'Main.ets'), 'export const version = "7.106.5";\n');
  git(source, 'add', 'Main.ets');
  git(source, 'commit', '-m', 'fixture');
  execFileSync('tar', ['-czf', archivePath, '-C', source, 'Main.ets']);
  const commit = git(source, 'rev-parse', 'HEAD');
  const archive = new Uint8Array(await readFile(archivePath));
  const componentCommit = 'b'.repeat(40);
  let componentArchive: Uint8Array | undefined;
  if (dynamicIos) {
    const component = join(root, 'component');
    await mkdir(component);
    await writeFile(join(component, 'NativePlayer.m'), 'void timeUpdateCallback(void) {}\n');
    execFileSync('tar', ['-czf', join(root, 'component.tar.gz'), '-C', component, 'NativePlayer.m']);
    componentArchive = new Uint8Array(await readFile(join(root, 'component.tar.gz')));
    await writeFile(join(source, 'Podfile'), "pod 'XesAppJSBridge', '3.4.4'\npod 'XesAppUnavailable', '1.0.0'\n");
    execFileSync('tar', ['-czf', archivePath, '-C', source, 'Main.ets', 'Podfile']);
  }
  const shellArchive = dynamicIos ? new Uint8Array(await readFile(archivePath)) : archive;
  let componentDownloads = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/repository/tags?')) {
      return Response.json([{ name: 'XesAppHD_v5.105.0_1_20260922', commit: { id: commit } }]);
    }
    if (url.includes('/repository/tags/')) {
      const name = decodeURIComponent(url.split('/repository/tags/')[1]!);
      return Response.json({ name, commit: { id: componentCommit } });
    }
    if (url.includes('/commits/')) {
      const id = url.split('/commits/')[1]!;
      return Response.json({ id, short_id: id.slice(0, 8) });
    }
    if (url.includes('XesAppUnavailableCode') && url.includes('archive.tar.gz')) return new Response('', { status: 403 });
    if (url.includes('XesAppJSBridgeCode') && url.includes('archive.tar.gz')) {
      componentDownloads++;
      return new Response(componentArchive!, { status: 200 });
    }
    if (url.includes('/chat/completions')) {
      const chunk = JSON.stringify({
        id: 'fixture-completion',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fixture',
        choices: [{ index: 0, delta: { role: 'assistant', content: '已完成源码绑定验收。' }, finish_reason: null }],
      });
      const end = JSON.stringify({
        id: 'fixture-completion',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      return new Response(`data: ${chunk}\n\ndata: ${end}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(shellArchive, { status: 200 });
  };

  const config = loadTestConfig(root, {
    HARMONY_AGENT_RUN_MODE: 'local',
    HARMONY_MASTRA_DATA_DIR: undefined,
    HARMONY_AGENT_DATA_ROOT: join(root, 'data'),
    HARMONY_AGENT_VERSION_REGISTRY_ROOT: registry,
    HARMONY_AGENT_GITLAB_BASE_URL: 'https://git.example.test',
    HARMONY_AGENT_GITLAB_TOKEN: 'test-token',
    HARMONY_AGENT_MODEL_CONFIG_FILE: join(root, 'model-config.json'),
  });
  await writeFile(config.modelConfigFile, JSON.stringify({
    provider: 'custom',
    model_name: 'fixture',
    base_url: 'https://model.example.test/v1',
    api_key: 'fixture-key',
    compatibility_mode: 'standard',
  }));
  const runtime = await createRuntimeApp(config);
  try {
    if (dynamicIos) {
      await mkdir(join(registry, 'ios'), { recursive: true });
      await writeFile(join(registry, 'ios', 'xuejiayun.yaml'), JSON.stringify([{
        version: '5.106.0', form_factor: 'universal', builds: [{
          build: '1', tag: 'XesAppHD_v5.106.0_1_20261105', source: 'manual', verified: true,
          repos: [{ repository_id: 'fixture/group/ios', role: 'shell', ref: 'XesAppHD_v5.106.0_1_20261105', expected_commit: 'a'.repeat(40) }],
        }],
      }]));
    }
    await mkdir(join(registry, 'android'), { recursive: true });
    await writeFile(join(registry, 'android', 'xueersi.yaml'), `
- version: 7.106.5
  form_factor: phone
  builds:
    - build: "55364"
      tag: V7.106.5-55364-CUSTOM
      source: manual
      verified: true
      repos:
        - repository_id: fixture/group/fixture-app
          role: shell
          ref: V7.106.5-55364-CUSTOM
          expected_commit: ${commit}
`);
    await runtime.versionRegistry.load();

    const response = await runtime.app.request(`${config.appPrefix}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://testserver' },
      body: JSON.stringify({ title: '动态源码绑定' }),
    });
    if (response.status !== 201) assert.fail(await response.text());
    const created = await response.json() as { id: string };
    const messageResponse = await runtime.app.request(`${config.appPrefix}/api/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://testserver' },
      body: JSON.stringify({ content: dynamicIos ? '请查询 iOS 学家云 iPad 5.105.0 的客户端逻辑' : '请查询 Android 7.106.5 build 55364 的客户端逻辑' }),
    });
    if (messageResponse.status !== 200) assert.fail(await messageResponse.text());
    await messageResponse.text();
    const conversation = await (await runtime.app.request(`${config.appPrefix}/api/conversations/${created.id}`)).json() as {
      repository_id: string;
      resolved_commit: string;
      platform: string;
      version: string;
      build: string;
      workspace_path: string;
    };
    assert.match(conversation.repository_id, /^registry-/);
    assert.equal(conversation.resolved_commit, commit);
    assert.equal(conversation.platform, dynamicIos ? 'ios' : 'android');
    assert.equal(conversation.version, dynamicIos ? '5.105.0' : '7.106.5');
    assert.equal(conversation.build, dynamicIos ? '1' : '55364');
    assert.equal(await readFile(join(conversation.workspace_path, 'Main.ets'), 'utf8'), 'export const version = "7.106.5";\n');
    const snapshot = await runtime.store.getSnapshot(conversation.repository_id, commit);
    assert.equal(snapshot.source, 'gitlab-api-archive');
    if (dynamicIos) {
      assert.equal(await readFile(join(conversation.workspace_path, 'components/XesAppJSBridge/NativePlayer.m'), 'utf8'), 'void timeUpdateCallback(void) {}\n');
      const saved = await runtime.store.getConversation(created.id);
      assert.equal(saved.source_repositories.length, 2);
      assert.equal(saved.source_repositories[1]?.resolved_commit, componentCommit);
      assert.equal(saved.source_completeness, 'partial');
      assert.match(saved.source_limitations.join(), /实际打包版本/);
      assert.match(saved.source_limitations.join(), /XesAppUnavailableCode.*HTTP 403/);
      // Existing shell-only conversations are enriched while retaining the original shell commit.
      saved.workspace_path = snapshot.workspace_path;
      saved.source_repositories = saved.source_repositories.filter((repo) => repo.role === 'shell');
      await runtime.store.saveConversation(saved);
      const followup = await runtime.app.request(`${config.appPrefix}/api/conversations/${created.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://testserver' },
        body: JSON.stringify({ content: '继续核查客户端' }),
      });
      assert.equal(followup.status, 200);
      await followup.text();
      const enriched = await runtime.store.getConversation(created.id);
      assert.equal(enriched.resolved_commit, commit);
      assert.equal(enriched.source_repositories.length, 2);
      assert.equal(componentDownloads, 1, 'component archive should be reused by commit');
    }
  } finally {
    globalThis.fetch = previousFetch;
    await runtime.mastra.getStorage()?.close();
    await runtime.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
}
