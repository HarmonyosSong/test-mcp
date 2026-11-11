import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RepositoryAlreadyExistsError,
  RepositoryCapability,
  RepositoryGitError,
  SnapshotNotReadyError,
  SourceSelectionError,
  selectRepositoryVersion,
} from '../src/capabilities/repository.js';

const execFile = promisify(execFileCallback);

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

async function createRemote(root: string): Promise<{ remote: string; source: string; commit: string; featureCommit: string }> {
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  await git(['init', '--bare', remote]);
  await git(['init', '-b', 'main', source]);
  await git(['config', 'user.name', 'Repository Test'], source);
  await git(['config', 'user.email', 'repository-test@example.invalid'], source);
  await writeFile(join(source, 'Main.ets'), 'const state = "main";\n');
  await git(['add', 'Main.ets'], source);
  await git(['commit', '-m', 'main commit'], source);
  const commit = await git(['rev-parse', 'HEAD'], source);
  await git(['remote', 'add', 'origin', `file://${remote}`], source);
  await git(['push', '-u', 'origin', 'main'], source);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  await git(['switch', '-c', 'feature/student-order'], source);
  await writeFile(join(source, 'Main.ets'), 'const state = "feature";\n');
  await git(['add', 'Main.ets'], source);
  await git(['commit', '-m', 'feature commit'], source);
  const featureCommit = await git(['rev-parse', 'HEAD'], source);
  await git(['push', '-u', 'origin', 'feature/student-order'], source);
  return { remote, source, commit, featureCommit };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mastra-repository-'));
  const { remote, source, commit, featureCommit } = await createRemote(root);
  const repositories = new RepositoryCapability({
    mirrorDir: join(root, 'mirrors'),
    snapshotDir: join(root, 'snapshots'),
    allowedRoots: [root],
  });
  return { root, remote, source, commit, featureCommit, repositories };
}

test('registers a local remote, discovers branches, and prepares a reusable detached snapshot', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({ name: 'xesapp', url: `file://${state.remote}` });
    assert.equal(record.default_branch, 'main');
    assert.deepEqual((await state.repositories.list()).map((item) => item.id), [record.id]);

    const branches = await state.repositories.listBranches(record.id, { query: 'STUDENT', limit: 20 });
    assert.deepEqual(branches.map((item) => item.name), ['feature/student-order']);

    const snapshot = await state.repositories.prepareSnapshot(record.id, 'main');
    assert.equal(snapshot.resolved_commit, state.commit);
    assert.equal(await readFile(join(snapshot.workspace_path, 'Main.ets'), 'utf8'), 'const state = "main";\n');
    assert.equal(await git(['symbolic-ref', '-q', 'HEAD'], snapshot.workspace_path).then(() => true, () => false), false);
    assert.deepEqual(await state.repositories.validateSnapshot(snapshot), snapshot);

    const reused = await state.repositories.prepareSnapshot(record.id, 'main');
    assert.equal(reused.workspace_path, snapshot.workspace_path);
    assert.equal(reused.resolved_commit, snapshot.resolved_commit);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('更新默认分支前验证远端，持久化失败或分支不存在时保留原记录和旧快照', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({ name: 'xesapp', url: `file://${state.remote}` });
    const snapshot = await state.repositories.prepareSnapshot(record.id, 'main');
    let persisted = '';
    const updated = await state.repositories.updateDefaultBranch(
      record.id,
      ' feature/student-order ',
      async (value) => { persisted = value.default_branch; },
    );
    assert.equal(updated.default_branch, 'feature/student-order');
    assert.equal(persisted, 'feature/student-order');
    assert.equal((await state.repositories.get(record.id)).default_branch, 'feature/student-order');
    assert.equal(snapshot.requested_ref, 'main');
    assert.equal(snapshot.resolved_commit, state.commit);

    await assert.rejects(
      () => state.repositories.updateDefaultBranch(record.id, 'missing'),
      /remote branch not found/,
    );
    assert.equal((await state.repositories.get(record.id)).default_branch, 'feature/student-order');
    await assert.rejects(
      () => state.repositories.updateDefaultBranch(record.id, 'main', async () => {
        throw new Error('database unavailable');
      }),
      /database unavailable/,
    );
    assert.equal((await state.repositories.get(record.id)).default_branch, 'feature/student-order');
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('normalizes single-slash file URLs before passing local repositories to Git', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({ name: 'local-shorthand', url: `file:${state.remote}` });
    assert.equal(record.url, `file://${state.remote}`);
    const branches = await state.repositories.listBranches(record.id);
    assert.ok(branches.some((branch) => branch.name === 'main'));
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('rejects credentials, local-root escapes, invalid refs, missing branches, and duplicate registrations', async () => {
  const state = await fixture();
  try {
    await assert.rejects(
      () => state.repositories.register({ name: 'invalid', url: 'https://user:secret@example.test/repo.git' }),
    );
    for (const url of [
      'https://example.test/repo.git?token=secret',
      'https://example.test/repo.git#branch',
      'ssh://git@example.test/team/repo.git?token=secret',
      'ssh://git@example.test/team/repo.git#branch',
    ]) {
      await assert.rejects(() => state.repositories.register({ name: 'invalid', url }), /repository URL/);
    }
    await assert.rejects(
      () => state.repositories.register({ name: 'outside', url: `file://${join(tmpdir(), 'outside.git')}` }),
      /outside allowed roots|does not exist/,
    );

    const record = await state.repositories.register({ name: 'xesapp', url: `file://${state.remote}` });
    await assert.rejects(
      () => state.repositories.register({ name: 'XESAPP', url: `file://${state.remote}` }),
      RepositoryAlreadyExistsError,
    );
    await assert.rejects(() => state.repositories.prepareSnapshot(record.id, '-bad'), RepositoryGitError);
    await assert.rejects(
      () => state.repositories.register({ name: 'missing', url: `file://${state.remote}`, default_branch: 'missing' }),
      /remote branch not found/,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('Git receives only the repository capability environment allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mastra-git-env-'));
  const bin = join(root, 'bin');
  const environmentFile = join(root, 'environment.txt');
  const gitPath = join(bin, 'git');
  const originalPath = process.env.PATH;
  const secretKey = 'RUNTIME_GIT_AUDIT_SECRET';
  const configKey = 'GIT_CONFIG_COUNT';
  const originalSecret = process.env[secretKey];
  const originalConfig = process.env[configKey];
  try {
    await mkdir(bin);
    await writeFile(gitPath, `#!/bin/sh\nenv > '${environmentFile}'\nprintf 'a%.0s' $(seq 1 40)\nprintf '\\trefs/heads/main\\n'\n`);
    await chmod(gitPath, 0o700);
    process.env.PATH = `${bin}${originalPath ? `:${originalPath}` : ''}`;
    process.env[secretKey] = 'runtime-secret-sentinel';
    process.env[configKey] = '1';

    const repositories = new RepositoryCapability({
      mirrorDir: join(root, 'mirrors'),
      snapshotDir: join(root, 'snapshots'),
    });
    const record = await repositories.register({
      name: 'remote', url: 'https://example.test/repo.git', default_branch: 'main',
    });
    assert.equal(record.url, 'https://example.test/repo.git');

    const childEnvironment = await readFile(environmentFile, 'utf8');
    assert.equal(childEnvironment.includes('RUNTIME_GIT_AUDIT_SECRET='), false);
    assert.equal(childEnvironment.includes('GIT_CONFIG_COUNT='), false);
    assert.match(childEnvironment, /GIT_TERMINAL_PROMPT=0/);
    assert.match(childEnvironment, /PATH=/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSecret === undefined) delete process.env[secretKey];
    else process.env[secretKey] = originalSecret;
    if (originalConfig === undefined) delete process.env[configKey];
    else process.env[configKey] = originalConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects reused snapshot metadata whose repository identity or commit is altered', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({ name: 'xesapp', url: `file://${state.remote}` });
    const snapshot = await state.repositories.prepareSnapshot(record.id, 'main');
    const metadataPath = join(snapshot.workspace_path, '.harmony-agent-snapshot.json');
    const original = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;

    await writeFile(metadataPath, JSON.stringify({ ...original, repository_id: 'repo-forged' }));
    await assert.rejects(() => state.repositories.validateSnapshot(snapshot), /metadata.*identity/);
    await assert.rejects(() => state.repositories.prepareSnapshot(record.id, 'main'), /metadata.*identity/);

    await writeFile(metadataPath, JSON.stringify(original));
    await git(['reset', '--hard', state.featureCommit], snapshot.workspace_path);
    await assert.rejects(() => state.repositories.validateSnapshot(snapshot), /HEAD does not match/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('rejects snapshot metadata paths that point outside the expected snapshot directory', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({ name: 'xesapp', url: `file://${state.remote}` });
    const snapshot = await state.repositories.prepareSnapshot(record.id, 'main');
    const metadataPath = join(snapshot.workspace_path, '.harmony-agent-snapshot.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    await writeFile(metadataPath, JSON.stringify({ ...metadata, workspace_path: state.root }));
    await assert.rejects(() => state.repositories.validateSnapshot(snapshot), /metadata.*identity/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('平台与精确版本映射只选择唯一记录，不回退默认分支或未知平台', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({
      name: 'xesapp',
      url: `file://${state.remote}`,
      platform: 'harmony',
      version_map: {
        'fixture-1.0': { branch: 'main', expected_commit: state.commit },
      },
    });
    assert.equal(record.platform, 'harmony');
    assert.equal(record.version_map['fixture-1.0']?.expected_commit, state.commit);
    assert.equal(selectRepositoryVersion([record], 'harmony', 'fixture-1.0').repository.id, record.id);
    for (const [platform, version, code] of [
      [null, 'fixture-1.0', 'platform_unconfirmed'],
      ['unknown', 'fixture-1.0', 'platform_unconfirmed'],
      ['harmony', null, 'version_required'],
      ['harmony', '9.9.9', 'version_mapping_missing'],
      ['android', 'fixture-1.0', 'version_mapping_missing'],
    ] as const) {
      assert.throws(
        () => selectRepositoryVersion([record], platform, version),
        (error: unknown) => error instanceof SourceSelectionError && error.code === code,
      );
    }
    const duplicate = { ...record, id: 'repo-duplicate', name: 'duplicate' };
    assert.throws(
      () => selectRepositoryVersion([record, duplicate], 'harmony', 'fixture-1.0'),
      (error: unknown) => error instanceof SourceSelectionError && error.code === 'version_mapping_ambiguous',
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('精确快照复用已准备的固定 commit，远端不可用时不 fetch 也不回退', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({
      name: 'xesapp',
      url: `file://${state.remote}`,
      platform: 'harmony',
      version_map: {
        'fixture-1.0': { branch: 'main', expected_commit: state.commit },
        'fixture-2.0': { branch: 'feature/student-order', expected_commit: state.featureCommit },
      },
    });
    const prepared = await state.repositories.prepareSnapshot(record.id, 'main');
    await rm(state.remote, { recursive: true, force: true });

    const selected = await state.repositories.selectPreparedSnapshot('harmony', 'fixture-1.0');
    assert.deepEqual(selected.snapshot, prepared);
    assert.equal(selected.snapshot.resolved_commit, state.commit);
    await assert.rejects(
      () => state.repositories.selectPreparedSnapshot('harmony', 'fixture-2.0'),
      (error: unknown) => error instanceof SnapshotNotReadyError && error.code === 'snapshot_not_ready',
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('版本映射更新原子持久化，非法分支不改记录，旧会话快照保持不变', async () => {
  const state = await fixture();
  try {
    const record = await state.repositories.register({ name: 'xesapp', url: `file://${state.remote}` });
    const snapshot = await state.repositories.prepareSnapshot(record.id, 'main');
    let persisted = false;
    const updated = await state.repositories.updateRepositoryConfiguration(record.id, {
      platform: 'android',
      version_map: {
        'fixture-2.0': { branch: 'feature/student-order', expected_commit: state.featureCommit },
      },
    }, async () => { persisted = true; });
    assert.equal(persisted, true);
    assert.equal(updated.platform, 'android');
    assert.equal(updated.default_branch, 'main');
    assert.equal(snapshot.resolved_commit, state.commit);

    await assert.rejects(() => state.repositories.updateRepositoryConfiguration(record.id, {
      version_map: { broken: { branch: 'missing', expected_commit: state.commit } },
    }), /remote branch not found/);
    assert.deepEqual((await state.repositories.get(record.id)).version_map, updated.version_map);
    await assert.rejects(() => state.repositories.updateRepositoryConfiguration(record.id, {
      platform: 'ios',
    }, async () => { throw new Error('database unavailable'); }), /database unavailable/);
    assert.equal((await state.repositories.get(record.id)).platform, 'android');
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
