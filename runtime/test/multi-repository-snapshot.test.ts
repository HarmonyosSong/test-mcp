import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  materializeMultiRepositorySnapshot,
  MultiRepositorySnapshotError,
} from '../src/capabilities/multi-repository-snapshot.js';

const commit = (letter: string) => letter.repeat(40);

function snapshot(repositoryId: string, repositoryName: string, workspacePath: string, resolvedCommit: string) {
  return {
    repository_id: repositoryId,
    repository_name: repositoryName,
    requested_ref: 'release-7.106.5',
    resolved_commit: resolvedCommit,
    workspace_path: workspacePath,
    source: 'gitlab-api-archive' as const,
    created_at: new Date(0).toISOString(),
  };
}

test('组合快照按挂载路径合并多个固定 commit，并可幂等复用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-repository-snapshot-'));
  try {
    const shell = join(root, 'shell');
    const component = join(root, 'component');
    await mkdir(join(shell, 'components'), { recursive: true });
    await mkdir(component, { recursive: true });
    await writeFile(join(shell, 'Entry.ets'), 'export const side = "shell";\n');
    await writeFile(join(component, 'Page.ets'), 'export const side = "component";\n');
    await writeFile(join(component, '.harmony-agent-snapshot.json'), 'source metadata must not be mounted');

    const input = [
      { snapshot: snapshot('repo-shell', 'shell', shell, commit('a')), role: 'shell' as const, mountPath: '' },
      { snapshot: snapshot('repo-component', 'component', component, commit('b')), role: 'component' as const, mountPath: 'components/feature' },
    ];
    const first = await materializeMultiRepositorySnapshot({ snapshotRoot: root, repositories: input });
    assert.equal(await readFile(join(first.workspace_path, 'Entry.ets'), 'utf8'), 'export const side = "shell";\n');
    assert.equal(await readFile(join(first.workspace_path, 'components/feature/Page.ets'), 'utf8'), 'export const side = "component";\n');
    assert.equal(first.repositories.find((item) => item.role === 'component')?.mount_path, 'components/feature');

    const second = await materializeMultiRepositorySnapshot({ snapshotRoot: root, repositories: input });
    assert.equal(second.workspace_path, first.workspace_path);
    assert.equal(second.created_at, first.created_at);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('组合快照拒绝不安全挂载、文件冲突和符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-repository-snapshot-unsafe-'));
  try {
    const shell = join(root, 'shell');
    const component = join(root, 'component');
    await mkdir(join(shell, 'components', 'feature'), { recursive: true });
    await mkdir(component, { recursive: true });
    await writeFile(join(shell, 'components', 'feature', 'Page.ets'), 'shell wins? no\n');
    await writeFile(join(component, 'Page.ets'), 'component\n');
    const base = [
      { snapshot: snapshot('repo-shell', 'shell', shell, commit('a')), role: 'shell' as const, mountPath: '' },
      { snapshot: snapshot('repo-component', 'component', component, commit('b')), role: 'component' as const, mountPath: 'components/feature' },
    ];
    await assert.rejects(
      materializeMultiRepositorySnapshot({ snapshotRoot: root, repositories: base.map((item) => ({ ...item, mountPath: item.role === 'shell' ? '' : '../feature' })) }),
      MultiRepositorySnapshotError,
    );
    await assert.rejects(materializeMultiRepositorySnapshot({ snapshotRoot: root, repositories: base }), MultiRepositorySnapshotError);

    const linked = join(root, 'linked');
    await mkdir(linked);
    await symlink(join(root, 'outside'), join(linked, 'escape'));
    await assert.rejects(
      materializeMultiRepositorySnapshot({
        snapshotRoot: root,
        repositories: [
          { snapshot: snapshot('repo-shell-2', 'shell', linked, commit('c')), role: 'shell', mountPath: '' },
        ],
      }),
      MultiRepositorySnapshotError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
