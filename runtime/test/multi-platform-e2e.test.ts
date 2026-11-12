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

async function createRemote(root: string, name: string, fileName: string, content: string): Promise<{
  remote: string;
  source: string;
  commit: string;
  archive: Uint8Array;
}> {
  const source = join(root, `${name}-source`);
  const remote = join(root, `${name}.git`);
  const archivePath = join(root, `${name}.tar.gz`);
  await mkdir(source, { recursive: true });
  git(root, 'init', '-b', 'main', source);
  git(source, 'config', 'user.email', 'fixture@example.test');
  git(source, 'config', 'user.name', 'Fixture');
  await writeFile(join(source, fileName), content);
  git(source, 'add', fileName);
  git(source, 'commit', '-m', `fixture ${name}`);
  execFileSync('git', ['clone', '--bare', source, remote]);
  execFileSync('tar', ['-czf', archivePath, '-C', source, '.']);
  return {
    remote,
    source,
    commit: git(source, 'rev-parse', 'HEAD'),
    archive: new Uint8Array(await readFile(archivePath)),
  };
}

test('HarmonyOS、Android、iOS 都能从登记表解析固定版本，空会话不预绑定源码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-platform-e2e-'));
  const previousFetch = globalThis.fetch;
  try {
    const shell = await createRemote(root, 'shell', 'Entry.ets', 'export const source = "shell";\n');
    const component = await createRemote(root, 'component', 'Page.ets', 'export const source = "component";\n');
    const archiveByCommit = new Map([[shell.commit, shell.archive], [component.commit, component.archive]]);
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/repository/commits/')) {
        const expected = url.pathname.split('/').at(-1)!;
        return new Response(JSON.stringify({ id: expected, short_id: expected.slice(0, 8) }), { status: 200 });
      }
      const archive = archiveByCommit.get(url.searchParams.get('sha') ?? '');
      return archive ? new Response(archive, { status: 200 }) : new Response('missing archive', { status: 404 });
    };

    const registryRoot = join(root, 'version-registry');
    const config = loadTestConfig(root, {
      HARMONY_AGENT_RUN_MODE: 'local',
      HARMONY_MASTRA_DATA_DIR: undefined,
      HARMONY_AGENT_DATA_ROOT: join(root, 'data'),
      HARMONY_AGENT_ALLOWED_ROOTS: root,
      HARMONY_AGENT_VERSION_REGISTRY_ROOT: registryRoot,
      HARMONY_AGENT_GITLAB_BASE_URL: 'https://git.example.test',
      HARMONY_AGENT_GITLAB_TOKEN: 'test-token',
    });
    const runtime = await createRuntimeApp(config);
    try {
      // Registry paths are enough. Runtime creates its internal repository
      // records on demand; users never need to pre-register these sources.
      const shellRepositoryId = 'fixture/shell';
      const componentRepositoryId = 'fixture/component';

      for (const platform of ['harmony', 'android', 'ios'] as const) {
        await mkdir(join(registryRoot, platform), { recursive: true });
        await writeFile(join(registryRoot, platform, 'xueersi.yaml'), `
- version: 7.106.5
  form_factor: universal
  builds:
    - tag: release-7.106.5
      source: manual
      verified: true
      repos:
        - repository_id: ${shellRepositoryId}
          role: shell
          ref: release-7.106.5
          expected_commit: ${shell.commit}
        - repository_id: ${componentRepositoryId}
          role: component
          mount_path: components/feature
          ref: release-7.106.5
          expected_commit: ${component.commit}
`);
      }
      await runtime.versionRegistry.load();

      for (const platform of ['harmony', 'android', 'ios'] as const) {
        const response = await runtime.app.request(`${config.appPrefix}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://testserver' },
          body: JSON.stringify({ title: `${platform} 动态会话` }),
        });
        if (response.status !== 201) assert.fail(`${platform}: ${await response.text()}`);
        const conversation = await response.json() as {
          platform: string | null;
          source_repositories: unknown[];
          workspace_path: string | null;
        };
        assert.equal(conversation.platform, null);
        assert.deepEqual(conversation.source_repositories, []);
        assert.equal(conversation.workspace_path, null);
        const selected = runtime.versionRegistry.select({ platform, productLine: 'xueersi', version: '7.106.5' });
        assert.equal(selected.repositories.length, 2);
        assert.equal(selected.repositories.find((item) => item.role === 'shell')?.expected_commit, shell.commit);
      }

      const rejectedPreselection = await runtime.app.request(`${config.appPrefix}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://testserver' },
        body: JSON.stringify({ platform: 'android', product_line: 'xueersi', version: '7.106.5' }),
      });
      assert.equal(rejectedPreselection.status, 422);

      await mkdir(join(registryRoot, 'android'), { recursive: true });
      await writeFile(join(registryRoot, 'android', 'xuejiayun.yaml'), `
- version: 7.106.6
  builds:
    - tag: release-7.106.5
      source: manual
      verified: true
      repos:
        - repository_id: ${shellRepositoryId}
          role: shell
          ref: release-7.106.5
          expected_commit: ${shell.commit}
`);
      await runtime.versionRegistry.load();
      const partialResponse = await runtime.app.request(`${config.appPrefix}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://testserver' },
        body: JSON.stringify({ platform: 'android', product_line: 'xuejiayun', version: '7.106.6' }),
      });
      assert.equal(partialResponse.status, 422);
      const partial = runtime.versionRegistry.select({ platform: 'android', productLine: 'xuejiayun', version: '7.106.6' });
      assert.equal(partial.repositories.length, 1);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
