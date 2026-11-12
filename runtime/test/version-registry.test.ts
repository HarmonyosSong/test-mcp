import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadVersionRegistry,
  selectVersionRegistryEntry,
  VersionRegistry,
  VersionRegistryError,
} from '../src/capabilities/version-registry.js';

const COMMIT = 'a'.repeat(40);

test('加载版本登记表并按平台、产品线、形态和构建号唯一选择', async () => {
  const root = await mkdtemp(join(tmpdir(), 'version-registry-'));
  try {
    await mkdir(join(root, 'android'));
    await writeFile(join(root, 'android', 'xueersi.yaml'), `
- version: 7.106.5
  form_factor: phone
  builds:
    - build: "55364"
      tag: V7.106.5-55364-CUSTOM
      source: tag-scan
      verified: true
      repos:
        - repository_id: group/app
          role: shell
          ref: V7.106.5-55364-CUSTOM
          expected_commit: ${COMMIT}
`);
    const entries = await loadVersionRegistry(root);
    const registry = new VersionRegistry(root);
    await registry.load();
    assert.equal(registry.entries().length, 1);
    const selected = selectVersionRegistryEntry(entries, {
      platform: 'android',
      productLine: 'xueersi',
      formFactor: 'phone',
      version: 'V7.106.5',
      build: '55364',
    });
    assert.equal(selected.build.tag, 'V7.106.5-55364-CUSTOM');
    assert.equal(selected.repositories[0]?.expected_commit, COMMIT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('多个已核验构建没有 build 时拒绝猜测，未核验版本不参与选择', () => {
  const entry = {
    platform: 'harmony' as const,
    product_line: 'xueersi' as const,
    version: '7.106.5',
    form_factor: 'universal' as const,
    builds: [
      { build: '1', tag: '7.106.5-1', source: 'manual' as const, verified: true, repos: [{ repository_id: 'app', role: 'shell' as const, ref: '7.106.5-1', expected_commit: COMMIT }] },
      { build: '2', tag: '7.106.5-2', source: 'manual' as const, verified: true, repos: [{ repository_id: 'app', role: 'shell' as const, ref: '7.106.5-2', expected_commit: COMMIT }] },
    ],
  };
  assert.throws(
    () => selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi', version: '7.106.5' }),
    (error: unknown) => error instanceof VersionRegistryError && error.code === 'version_ambiguous',
  );
  assert.equal(selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi', version: '7.106.5', build: '2' }).build.build, '2');
  assert.throws(
    () => selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi', version: '7.106.5.1' }),
    (error: unknown) => error instanceof VersionRegistryError && error.code === 'build_required',
  );
});
