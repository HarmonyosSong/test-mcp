import assert from 'node:assert/strict';
import test from 'node:test';

import { upsertRepository } from '../src/repositories.ts';

const repository = {
  id: 'repo-1', name: 'xesapp', url: 'https://example.test/xesapp.git',
  default_branch: 'master', created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
};

test('更新默认分支只替换当前仓库，不修改旧状态或其他仓库', () => {
  const other = { ...repository, id: 'repo-2', name: 'cloudlearning' };
  const current = [other, repository];
  const updated = {
    ...repository, default_branch: 'releaseV/20261103',
    updated_at: '2026-11-11T00:00:00.000Z',
  };
  const next = upsertRepository(current, updated);
  assert.equal(next.length, 2);
  assert.equal(next.find((item) => item.id === 'repo-1')?.default_branch, 'releaseV/20261103');
  assert.equal(next.find((item) => item.id === 'repo-2')?.default_branch, 'master');
  assert.equal(repository.default_branch, 'master');
  assert.notEqual(next, current);
});

test('新登记仓库仍按名称排序', () => {
  const added = { ...repository, id: 'repo-3', name: 'android' };
  const next = upsertRepository([repository], added);
  assert.deepEqual(next.map((item) => item.name), ['android', 'xesapp']);
});
