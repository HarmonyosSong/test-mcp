import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RepositoryCapability } from '../src/capabilities/repository.js';

const COMMIT = 'a'.repeat(40);

async function tarFixture(files: Record<string, string>): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), 'repo-alias-fixture-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await writeFile(target, content);
    }
    const archivePath = join(root, 'fixture.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', root, ...Object.keys(files)]);
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(archivePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('同一 commit 不同 tag（发布列车/双产品线复用）复用快照并按调用方 ref 返回', async () => {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'repo-alias-'));
  try {
    const repositories = new RepositoryCapability({ snapshotDir });
    const record = await repositories.ensureRegistryRepository('group/xesapp', {
      baseUrl: 'https://git.example.test',
      ref: 'V7.106.0-55347-CUSTOM',
    });
    const archive = await tarFixture({ 'src/main.ets': '// 跨报\n' });
    const prepared = await repositories.prepareArchiveSnapshot(record.id, 'V7.106.0-55347-CUSTOM', COMMIT, archive);
    assert.equal(prepared.requested_ref, 'V7.106.0-55347-CUSTOM');

    // 另一产品线同一 commit 的另一 tag：不再抛 snapshot_conflict / ref 不一致
    const aliased = await repositories.getPreparedSnapshot(record.id, 'V5.106.0-1090-XUEJIAYUN', COMMIT);
    assert.equal(aliased.resolved_commit, COMMIT);
    assert.equal(aliased.requested_ref, 'V5.106.0-1090-XUEJIAYUN');
    assert.equal(aliased.workspace_path, prepared.workspace_path);

    // commit 不同仍然拒绝
    await assert.rejects(
      () => repositories.getPreparedSnapshot(record.id, 'V7.105.0-56071-CUSTOM', 'b'.repeat(40)),
      /尚未准备本地快照/,
    );
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
});
