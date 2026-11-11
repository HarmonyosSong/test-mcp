import assert from 'node:assert/strict';
import test from 'node:test';

import { createRepositoryRoutes } from '../src/http/repositories.js';
import {
  RepositoryAlreadyExistsError,
  RepositoryBranchError,
  RepositoryGitError,
  RepositoryNotFoundError,
  type RepositoryCapability,
  type RegisterRepositoryRequest,
} from '../src/capabilities/repository.js';
import { ProductNotFoundError } from '../src/product/store.js';
import type { ProductStore } from '../src/product/store.js';

test('repository route preserves branch query bounds and snapshot status contract', async () => {
  let branchCalls = 0;
  const snapshot = {
    repository_id: 'repo-1',
    repository_name: 'project',
    requested_ref: 'main',
    resolved_commit: 'a'.repeat(40),
    workspace_path: '/tmp/snapshot',
  };
  const capability = {
    async list() { return []; },
    async listBranches() { branchCalls += 1; return [{ name: 'main', commit: 'a'.repeat(40) }]; },
    async prepareSnapshot() { return snapshot; },
  } as unknown as RepositoryCapability;
  const store = { async saveSnapshot() {} } as unknown as ProductStore;
  const app = createRepositoryRoutes(capability, store);

  const ok = await app.request('/repositories/repo-1/branches?query=main&limit=500');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [{ name: 'main', commit: 'a'.repeat(40) }]);

  for (const invalidCase of [
    { query: `?query=${'x'.repeat(201)}`, type: 'string_too_long', field: 'query' },
    { query: '?limit=0', type: 'greater_than_equal', field: 'limit' },
    { query: '?limit=501', type: 'less_than_equal', field: 'limit' },
    { query: '?limit=1.5', type: 'int_parsing', field: 'limit' },
    { query: '?limit=abc', type: 'int_parsing', field: 'limit' },
  ]) {
    const invalid = await app.request(`/repositories/repo-1/branches${invalidCase.query}`);
    assert.equal(invalid.status, 422, invalidCase.query);
    const error = await invalid.json() as { detail: Array<{ type: string; loc: string[]; msg: string }> };
    assert.equal(error.detail[0].type, invalidCase.type);
    assert.deepEqual(error.detail[0].loc, ['query', invalidCase.field]);
    assert.equal(typeof error.detail[0].msg, 'string');
  }
  assert.equal(branchCalls, 1);

  const created = await app.request('/repositories/repo-1/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'main' }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), snapshot);

  const invalidBody = await app.request('/repositories/repo-1/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(invalidBody.status, 422);
});

test('默认分支更新先校验并持久化，保留请求和错误状态边界', async () => {
  const record = {
    id: 'repo-1', name: 'project', url: 'https://example.com/project.git',
    default_branch: 'releaseV/20261103', created_at: '2026-11-04T12:00:00.000Z',
    updated_at: '2026-11-11T12:00:00.000Z',
  };
  let persisted = 0;
  let requestedBranch = '';
  const app = createRepositoryRoutes({
    async updateDefaultBranch(id: string, branch: string, persist: (value: typeof record) => Promise<void>) {
      assert.equal(id, 'repo-1');
      requestedBranch = branch;
      await persist(record);
      return record;
    },
  } as unknown as RepositoryCapability, {
    async saveRepository() { persisted += 1; },
  } as unknown as ProductStore);
  const updated = await app.request('/repositories/repo-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ default_branch: 'releaseV/20261103' }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), record);
  assert.equal(requestedBranch, 'releaseV/20261103');
  assert.equal(persisted, 1);

  const invalid = await app.request('/repositories/repo-1', {
    method: 'PATCH', body: JSON.stringify({ default_branch: '' }),
  });
  assert.equal(invalid.status, 422);
  const extra = await app.request('/repositories/repo-1', {
    method: 'PATCH', body: JSON.stringify({ default_branch: 'main', url: 'https://attacker.invalid/repo.git' }),
  });
  assert.equal(extra.status, 422);
  assert.equal(persisted, 1);

  const missingBranchRoutes = createRepositoryRoutes({
    async updateDefaultBranch() { throw new RepositoryBranchError('remote branch not found: missing'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const missing = await missingBranchRoutes.request('/repositories/repo-1', {
    method: 'PATCH', body: JSON.stringify({ default_branch: 'missing' }),
  });
  assert.equal(missing.status, 422);
  assert.match((await missing.json() as { detail: string }).detail, /remote branch not found/);

  const unavailableRoutes = createRepositoryRoutes({
    async updateDefaultBranch() { throw new RepositoryGitError('remote unavailable'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const unavailable = await unavailableRoutes.request('/repositories/repo-1', {
    method: 'PATCH', body: JSON.stringify({ default_branch: 'main' }),
  });
  assert.equal(unavailable.status, 502);
});

test('仓库平台与版本映射通过同一受保护配置接口原子保存', async () => {
  const record = {
    id: 'repo-1', name: 'project', url: 'https://example.com/project.git',
    default_branch: 'main', platform: 'android',
    version_map: { 'fixture-1.0': { branch: 'main', expected_commit: 'a'.repeat(40) } },
    created_at: '2026-11-04T12:00:00.000Z', updated_at: '2026-11-11T12:00:00.000Z',
  };
  let persisted = 0;
  const app = createRepositoryRoutes({
    async updateRepositoryConfiguration(id: string, input: unknown, persist: (value: typeof record) => Promise<void>) {
      assert.equal(id, 'repo-1');
      assert.deepEqual(input, { platform: 'android', version_map: record.version_map });
      await persist(record);
      return record;
    },
  } as unknown as RepositoryCapability, {
    async saveRepository() { persisted += 1; },
  } as unknown as ProductStore);
  const response = await app.request('/repositories/repo-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', version_map: record.version_map }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), record);
  assert.equal(persisted, 1);

  const empty = await app.request('/repositories/repo-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(empty.status, 422);
  assert.equal(persisted, 1);
});

test('repository list returns the full registered repository records', async () => {
  const records = [{
    id: 'repo-1', name: 'project', url: 'https://example.com/project.git',
    default_branch: 'main', created_at: '2026-11-04T12:00:00.000Z',
  }];
  const routes = createRepositoryRoutes({ async list() { return records; } } as unknown as RepositoryCapability, {} as ProductStore);
  const response = await routes.request('/repositories');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), records);
});

test('repository routes preserve duplicate, git failure, and missing repository statuses', async () => {
  const app = createRepositoryRoutes({
    async list() { return []; },
    async register() { throw new RepositoryAlreadyExistsError('already registered'); },
    async listBranches() { throw new RepositoryNotFoundError('missing'); },
    async prepareSnapshot() { throw new RepositoryGitError('fetch failed'); },
  } as unknown as RepositoryCapability, {} as ProductStore);

  const duplicate = await app.request('/repositories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'project', url: 'https://example.com/project.git' }),
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { detail: 'already registered' });

  const missing = await app.request('/repositories/missing/branches');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { detail: 'repository not found' });

  const failedSnapshot = await app.request('/repositories/repo-1/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'main' }),
  });
  assert.equal(failedSnapshot.status, 422);
  assert.deepEqual(await failedSnapshot.json(), { detail: '快照创建失败：fetch failed' });
});

test('snapshot creation maps a missing repository to 404', async () => {
  const routes = createRepositoryRoutes({
    async prepareSnapshot() { throw new RepositoryNotFoundError('repo-1'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const response = await routes.request('/repositories/repo-1/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: 'main' }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { detail: 'repository not found' });
});

test('snapshot creation maps a repository removed before snapshot persistence to 404', async () => {
  const snapshot = {
    repository_id: 'repo-1', repository_name: 'project', requested_ref: 'main',
    resolved_commit: 'a'.repeat(40), workspace_path: '/tmp/snapshot',
  };
  const routes = createRepositoryRoutes({
    async prepareSnapshot() { return snapshot; },
  } as unknown as RepositoryCapability, {
    async saveSnapshot() { throw new ProductNotFoundError('repo-1'); },
  } as unknown as ProductStore);
  const response = await routes.request('/repositories/repo-1/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'main' }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { detail: 'repository not found' });
});

test('repository registration maps a remote Git failure to 502', async () => {
  const variable = 'RUNTIME_GIT_AUDIT_TOKEN';
  const previous = process.env[variable];
  const sentinel = 'git-error-token-sentinel';
  process.env[variable] = sentinel;
  const app = createRepositoryRoutes({
    async list() { return []; },
    async register() { throw new RepositoryGitError(`remote unavailable ${sentinel}`); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  try {
    const response = await app.request('/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'project', url: 'https://example.com/project.git' }),
    });
    assert.equal(response.status, 502);
    const result = await response.json() as { detail: string };
    assert.equal(result.detail.includes(sentinel), false);
    assert.match(result.detail, /remote unavailable/);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test('repository registration rejects invalid request data with the standard validation envelope', async () => {
  let registrations = 0;
  let persisted = 0;
  const app = createRepositoryRoutes({
    async list() { return []; },
    async register(input: RegisterRepositoryRequest) { registrations += 1; return { ...input }; },
  } as unknown as RepositoryCapability, {
    async saveRepository() { persisted += 1; },
  } as unknown as ProductStore);

  for (const url of [
    'https://example.com/repo.git?token=secret',
    'https://example.com/repo.git#branch',
    'ssh://git@example.com/team/repo.git?token=secret',
    'ssh://git@example.com/team/repo.git#branch',
  ]) {
    const response = await app.request('/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'project', url }),
    });
    assert.equal(response.status, 422, url);
    const responseBody = JSON.stringify(await response.json());
    assert.match(responseBody, /url/);
    assert.equal(responseBody.includes(url), false);
    assert.equal(responseBody.includes('secret'), false);
  }
  assert.equal(registrations, 0);
  assert.equal(persisted, 0);
});

test('unexpected repository persistence failures remain server errors', async () => {
  const routes = createRepositoryRoutes({
    async register() {
      return {
        id: 'repo-1', name: 'project', url: 'https://example.com/project.git',
        default_branch: 'main', created_at: new Date().toISOString(),
      };
    },
  } as unknown as RepositoryCapability, {
    async saveRepository() { throw new Error('database unavailable'); },
  } as unknown as ProductStore);
  const response = await routes.request('/repositories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'project', url: 'https://example.com/project.git' }),
  });
  assert.equal(response.status, 500);
});

test('unexpected repository listing, branch, and snapshot failures remain server errors', async () => {
  const listRoutes = createRepositoryRoutes({
    async list() { throw new Error('repository store unavailable'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const list = await listRoutes.request('/repositories');
  assert.equal(list.status, 500);

  const branchRoutes = createRepositoryRoutes({
    async list() { return []; },
    async listBranches() { throw new Error('git process failed unexpectedly'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const branches = await branchRoutes.request('/repositories/repo-1/branches');
  assert.equal(branches.status, 500);

  const snapshotRoutes = createRepositoryRoutes({
    async prepareSnapshot() { throw new Error('snapshot store unavailable'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const snapshot = await snapshotRoutes.request('/repositories/repo-1/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'main' }),
  });
  assert.equal(snapshot.status, 500);
});

test('branch listing maps an upstream Git failure to 502', async () => {
  const app = createRepositoryRoutes({
    async list() { return []; },
    async listBranches() { throw new RepositoryGitError('remote unavailable'); },
  } as unknown as RepositoryCapability, {} as ProductStore);
  const response = await app.request('/repositories/repo-1/branches');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { detail: '分支读取失败：remote unavailable' });
});
