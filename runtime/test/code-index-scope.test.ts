import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadCodeIndexScopeSummary } from '../src/capabilities/code-index-scope.js';

test('窗口描述：default 全列 + HD 独有版本追加', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'code-index-scope-'));
  try {
    const file = join(dir, 'version-scope.json');
    await writeFile(file, JSON.stringify({
      default: ['7.106.0', '7.105.0', '5.106.0', '5.105.0'],
      hd: ['7.106.0', '7.105.0', '5.107.0', '5.106.5', '5.106.0', '5.105.0'],
    }));
    assert.equal(
      loadCodeIndexScopeSummary(file),
      '默认窗口覆盖 7.106.0/7.105.0/5.106.0/5.105.0，HD 窗口另含 5.107.0/5.106.5',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HD 无独有版本时不追加尾巴；文件缺失/格式异常返回 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'code-index-scope-edge-'));
  try {
    const file = join(dir, 'version-scope.json');
    await writeFile(file, JSON.stringify({ default: ['7.106.0'], hd: ['7.106.0'] }));
    assert.equal(loadCodeIndexScopeSummary(file), '默认窗口覆盖 7.106.0');

    await writeFile(file, JSON.stringify({ hd: ['7.106.0'] }));
    assert.equal(loadCodeIndexScopeSummary(file), null);

    await writeFile(file, 'not json');
    assert.equal(loadCodeIndexScopeSummary(file), null);

    assert.equal(loadCodeIndexScopeSummary(join(dir, 'missing.json')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
