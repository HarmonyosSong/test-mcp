import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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
  const remote = join(root, 'remote.git');
  const archivePath = join(root, 'archive.tar.gz');
  const registry = join(root, 'version-registry');
  await execFileSync('git', ['init', '-b', 'main', source]);
  git(source, 'config', 'user.email', 'fixture@example.test');
  git(source, 'config', 'user.name', 'Fixture');
  await writeFile(join(source, 'Main.ets'), 'export const version = "7.106.5";\n');
  git(source, 'add', 'Main.ets');
  git(source, 'commit', '-m', 'fixture');
  execFileSync('git', ['clone', '--bare', source, remote]);
  execFileSync('tar', ['-czf', archivePath, '-C', source, 'Main.ets']);
  const commit = git(source, 'rev-parse', 'HEAD');
  const archive = new Uint8Array(await readFile(archivePath));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ id: commit, short_id: commit.slice(0, 8) }), { status: 200 });
    }
    return new Response(archive, { status: 200 });
  };

  const config = loadTestConfig(root, {
    HARMONY_AGENT_RUN_MODE: 'local',
    HARMONY_MASTRA_DATA_DIR: undefined,
    HARMONY_AGENT_DATA_ROOT: join(root, 'data'),
    HARMONY_AGENT_ALLOWED_ROOTS: root,
    HARMONY_AGENT_VERSION_REGISTRY_ROOT: registry,
    HARMONY_AGENT_GITLAB_BASE_URL: 'https://git.example.test',
    HARMONY_AGENT_GITLAB_TOKEN: 'test-token',
  });
  const runtime = await createRuntimeApp(config);
  try {
    const repository = await runtime.repositories.register({
      name: 'fixture-app',
      url: pathToFileURL(remote).href,
      default_branch: 'main',
    });
    await runtime.store.saveRepository(repository);
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
        - repository_id: ${repository.id}
          role: shell
          ref: V7.106.5-55364-CUSTOM
          expected_commit: ${commit}
`);
    await runtime.versionRegistry.load();

    const response = await runtime.app.request(`${config.appPrefix}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://testserver' },
      body: JSON.stringify({
        platform: 'android',
        product_line: 'xueersi',
        form_factor: 'phone',
        version: '7.106.5',
        build: '55364',
      }),
    });
    if (response.status !== 201) assert.fail(await response.text());
    const conversation = await response.json() as {
      repository_id: string;
      resolved_commit: string;
      platform: string;
      version: string;
      build: string;
      workspace_path: string;
    };
    assert.equal(conversation.repository_id, repository.id);
    assert.equal(conversation.resolved_commit, commit);
    assert.equal(conversation.platform, 'android');
    assert.equal(conversation.version, '7.106.5');
    assert.equal(conversation.build, '55364');
    assert.equal(await readFile(join(conversation.workspace_path, 'Main.ets'), 'utf8'), 'export const version = "7.106.5";\n');
    const snapshot = await runtime.store.getSnapshot(repository.id, commit);
    assert.equal(snapshot.source, 'gitlab-api-archive');
  } finally {
    globalThis.fetch = previousFetch;
    await runtime.mastra.getStorage()?.close();
    await runtime.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
