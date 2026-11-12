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

test('HarmonyOS、Android、iOS 都能绑定多仓固定版本并形成组件源码路径', async () => {
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
      const shellRecord = await runtime.repositories.register({
        name: 'fixture-shell',
        url: pathToFileURL(shell.remote).href,
        default_branch: 'main',
      });
      const componentRecord = await runtime.repositories.register({
        name: 'fixture-component',
        url: pathToFileURL(component.remote).href,
        default_branch: 'main',
      });
      await runtime.store.saveRepository(shellRecord);
      await runtime.store.saveRepository(componentRecord);

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
        - repository_id: ${shellRecord.id}
          role: shell
          ref: release-7.106.5
          expected_commit: ${shell.commit}
        - repository_id: ${componentRecord.id}
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
          body: JSON.stringify({ platform, product_line: 'xueersi', version: '7.106.5' }),
        });
        if (response.status !== 201) assert.fail(`${platform}: ${await response.text()}`);
        const conversation = await response.json() as {
          platform: string;
          source_repositories: Array<{ repository_id: string; role: string; mount_path: string; resolved_commit: string }>;
          workspace_path: string;
        };
        assert.equal(conversation.platform, platform);
        assert.equal(conversation.source_repositories.length, 2);
        assert.equal(conversation.source_repositories.find((item) => item.role === 'shell')?.resolved_commit, shell.commit);
        assert.equal(conversation.source_repositories.find((item) => item.role === 'component')?.mount_path, 'components/feature');
        assert.equal(await readFile(join(conversation.workspace_path, 'components/feature/Page.ets'), 'utf8'), 'export const source = "component";\n');
      }

      const latestResponse = await runtime.app.request(`${config.appPrefix}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://testserver' },
        body: JSON.stringify({ platform: 'android', product_line: 'xueersi' }),
      });
      if (latestResponse.status !== 201) assert.fail(await latestResponse.text());
      // Scope metadata alone does not preselect a source. The first prompt may
      // still provide an explicit version before the runtime binds a snapshot.
      const latest = await latestResponse.json() as {
        platform: string;
        product_line: string;
        version: string | null;
        workspace_path: string | null;
      };
      assert.equal(latest.platform, 'android');
      assert.equal(latest.product_line, 'xueersi');
      assert.equal(latest.version, null);
      assert.equal(latest.workspace_path, null);

      await mkdir(join(registryRoot, 'android'), { recursive: true });
      await writeFile(join(registryRoot, 'android', 'xuejiayun.yaml'), `
- version: 7.106.6
  builds:
    - tag: release-7.106.5
      source: manual
      verified: true
      repos:
        - repository_id: ${shellRecord.id}
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
      if (partialResponse.status !== 201) assert.fail(await partialResponse.text());
      const partial = await partialResponse.json() as { source_completeness: string; source_limitations: string[] };
      assert.equal(partial.source_completeness, 'partial');
      assert.match(partial.source_limitations[0] ?? '', /组件源码未挂载/);
    } finally {
      await runtime.mastra.getStorage()?.close();
      await runtime.store.close();
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
