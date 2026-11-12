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

test('创建精确版本会话时选择登记 commit、下载 GitLab archive 并绑定固定快照', async () => {
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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ id: commit, short_id: commit.slice(0, 8) }), { status: 200 });
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
    return new Response(archive, { status: 200 });
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
      body: JSON.stringify({ content: '请查询 Android 学而思 7.106.5 build 55364 的客户端逻辑' }),
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
    assert.equal(conversation.platform, 'android');
    assert.equal(conversation.version, '7.106.5');
    assert.equal(conversation.build, '55364');
    assert.equal(await readFile(join(conversation.workspace_path, 'Main.ets'), 'utf8'), 'export const version = "7.106.5";\n');
    const snapshot = await runtime.store.getSnapshot(conversation.repository_id, commit);
    assert.equal(snapshot.source, 'gitlab-api-archive');
  } finally {
    globalThis.fetch = previousFetch;
    await runtime.mastra.getStorage()?.close();
    await runtime.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
