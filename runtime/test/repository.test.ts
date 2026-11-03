import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  RepositoryAlreadyExistsError,
  RepositoryCapability,
  RepositoryGitError,
} from '../src/capabilities/repository.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'mastra-repository-'));
  const source = join(root, 'source');
  git(['init', '--initial-branch=main', source], root);
  git(['config', 'user.name', 'Test User'], source);
  git(['config', 'user.email', 'test@example.invalid'], source);
  await writeFile(join(source, 'README.md'), 'initial\n');
  git(['add', 'README.md'], source);
  git(['commit', '-m', 'initial'], source);
  const initialCommit = git(['rev-parse', 'HEAD'], source);
  git(['branch', 'feature/next'], source);
  git(['switch', 'feature/next'], source);
  await writeFile(join(source, 'README.md'), 'feature\n');
  git(['commit', '-am', 'feature'], source);
  const featureCommit = git(['rev-parse', 'HEAD'], source);
  git(['switch', 'main'], source);
  return { root, source, initialCommit, featureCommit };
}

function makeCapability(root: string): RepositoryCapability {
  return new RepositoryCapability({
    mirrorDir: join(root, 'mirrors'),
    snapshotDir: join(root, 'snapshots'),
    allowedRoots: [root],
  });
}

test('registers a local repository, lists branches, and creates an immutable detached snapshot', async () => {
  const fixture = await createRepository();
  const capability = makeCapability(fixture.root);
  const record = await capability.register({
    name: 'demo-repository',
    url: pathToFileURL(fixture.source).toString(),
    default_branch: 'main',
  });

  assert.equal(record.default_branch, 'main');
  assert.equal((await capability.list()).length, 1);
  const branches = await capability.listBranches(record.id);
  assert.deepEqual(branches.map((branch) => branch.name), ['feature/next', 'main']);
  assert.equal(branches.find((branch) => branch.name === 'feature/next')?.commit, fixture.featureCommit);

  const snapshot = await capability.prepareSnapshot(record.id, 'main');
  assert.equal(snapshot.resolved_commit, fixture.initialCommit);
  assert.equal(await readFile(join(snapshot.workspace_path, 'README.md'), 'utf8'), 'initial\n');
  assert.equal(git(['rev-parse', '--verify', 'HEAD'], snapshot.workspace_path), fixture.initialCommit);
  assert.throws(
    () => git(['symbolic-ref', '--quiet', 'HEAD'], snapshot.workspace_path),
    /Command failed/,
  );

  const reused = await capability.prepareSnapshot(record.id, 'main');
  assert.deepEqual(reused, snapshot);
  assert.equal(await capability.validateSnapshot(snapshot).then((value) => value.resolved_commit), fixture.initialCommit);
});

test('rejects unsafe URLs, local symlink escapes, duplicate registrations, and invalid branches', async () => {
  const fixture = await createRepository();
  const capability = makeCapability(fixture.root);

  await assert.rejects(
    () => capability.register({ name: 'credentials', url: 'https://user:pass@example.com/repo.git' }),
    /must include a host and must not contain credentials/,
  );
  const outside = await mkdtemp(join(tmpdir(), 'mastra-outside-'));
  const link = join(fixture.root, 'linked-repository');
  await symlink(fixture.source, link);
  const outsideCapability = new RepositoryCapability({
    mirrorDir: join(fixture.root, 'outside-mirrors'),
    snapshotDir: join(fixture.root, 'outside-snapshots'),
    allowedRoots: [outside],
  });
  await assert.rejects(
    () => outsideCapability.register({ name: 'linked', url: pathToFileURL(link).toString(), default_branch: 'main' }),
    /outside allowed roots/,
  );

  const record = await capability.register({
    name: 'demo-repository',
    url: pathToFileURL(fixture.source).toString(),
    default_branch: 'main',
  });
  await assert.rejects(
    () => capability.register({ name: 'DEMO-REPOSITORY', url: pathToFileURL(fixture.source).toString(), default_branch: 'main' }),
    (error: unknown) => error instanceof RepositoryAlreadyExistsError,
  );
  await assert.rejects(() => capability.prepareSnapshot(record.id, '-invalid'), /invalid branch name/);
  await assert.rejects(() => capability.prepareSnapshot(record.id, 'main..invalid'), /invalid branch/);
});

test('rejects a snapshot whose metadata or HEAD no longer identifies the requested commit', async () => {
  const fixture = await createRepository();
  const capability = makeCapability(fixture.root);
  const record = await capability.register({
    name: 'demo-repository',
    url: pathToFileURL(fixture.source).toString(),
    default_branch: 'main',
  });
  const snapshot = await capability.prepareSnapshot(record.id, 'main');
  const metadataPath = join(snapshot.workspace_path, '.harmony-agent-snapshot.json');
  const originalMetadata = await readFile(metadataPath, 'utf8');

  await writeFile(metadataPath, originalMetadata.replace(snapshot.resolved_commit, fixture.featureCommit));
  await assert.rejects(
    () => capability.prepareSnapshot(record.id, 'main'),
    /metadata commit does not match requested remote commit/,
  );
  await writeFile(metadataPath, originalMetadata);

  await capability.prepareSnapshot(record.id, 'feature/next');
  git(['checkout', '--detach', fixture.featureCommit], snapshot.workspace_path);
  await assert.rejects(
    () => capability.prepareSnapshot(record.id, 'main'),
    (error: unknown) => error instanceof RepositoryGitError && /HEAD does not match metadata commit/.test(error.message),
  );
});
