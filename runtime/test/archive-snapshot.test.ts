import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArchiveSnapshotError, materializeArchiveSnapshot, validateArchiveSnapshot } from '../src/capabilities/archive-snapshot.js';

const COMMIT = 'c'.repeat(40);

async function archiveFixture(files: Record<string, string>): Promise<{ root: string; archive: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), 'archive-source-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    await writeFile(target, content);
  }
  const archivePath = join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', root, ...Object.keys(files)]);
  const archive = new Uint8Array(await readFile(archivePath));
  return { root, archive };
}

function traversalArchive(): Uint8Array {
  const name = '../escape.txt';
  const content = Buffer.from('nope');
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.fill(' ', 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return new Uint8Array(gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)])));
}

test('archive 快照原子解包、去掉 GitLab 顶层目录并可复核', async () => {
  const source = await archiveFixture({ 'project-src/Main.ets': 'const answer = 42;\n' });
  const root = await mkdtemp(join(tmpdir(), 'archive-snapshot-'));
  try {
    const snapshot = await materializeArchiveSnapshot({
      snapshotRoot: root,
      repositoryId: 'repo-1',
      repositoryName: 'project',
      requestedRef: 'V7.106.5-1',
      expectedCommit: COMMIT,
      archive: source.archive,
    });
    assert.equal(snapshot.source, 'gitlab-api-archive');
    assert.equal(await readFile(join(snapshot.workspace_path, 'Main.ets'), 'utf8'), 'const answer = 42;\n');
    assert.deepEqual(await validateArchiveSnapshot(snapshot, root), snapshot);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('archive 快照拒绝路径穿越和符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-snapshot-'));
  const unsafe = await mkdtemp(join(tmpdir(), 'archive-unsafe-'));
  try {
    const symlinkTarget = join(unsafe, 'outside.txt');
    await writeFile(symlinkTarget, 'outside');
    const source = join(unsafe, 'source');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(source));
    await symlink(symlinkTarget, join(source, 'link.txt'));
    const archivePath = join(unsafe, 'symlink.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', unsafe, 'source']);
    const archive = new Uint8Array(await readFile(archivePath));
    await assert.rejects(
      () => materializeArchiveSnapshot({ snapshotRoot: root, repositoryId: 'repo-2', repositoryName: 'project', requestedRef: 'main', expectedCommit: COMMIT, archive }),
      (error: unknown) => error instanceof ArchiveSnapshotError && error.code === 'unsafe_archive',
    );
    await assert.rejects(
      () => materializeArchiveSnapshot({ snapshotRoot: root, repositoryId: 'repo-3', repositoryName: 'project', requestedRef: 'main', expectedCommit: COMMIT, archive: traversalArchive() }),
      (error: unknown) => error instanceof ArchiveSnapshotError && error.code === 'unsafe_archive',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(unsafe, { recursive: true, force: true });
  }
});
