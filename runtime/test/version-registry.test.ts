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

test('版本或构建号未提供时选择最新的已核验版本和构建', () => {
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
  assert.equal(selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi', version: '7.106.5' }).build.build, '2');
  assert.equal(selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi' }).build.build, '2');
  assert.equal(selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi', version: '7.106.5', build: '2' }).build.build, '2');
  assert.throws(
    () => selectVersionRegistryEntry([entry], { platform: 'harmony', productLine: 'xueersi', version: '7.106.5.1' }),
    (error: unknown) => error instanceof VersionRegistryError && error.code === 'build_required',
  );
});

test('没有版本时按平台、产品线和形态选择最新版本', () => {
  const entries = [
    {
      platform: 'android' as const,
      product_line: 'xueersi' as const,
      version: '7.106.4',
      form_factor: 'phone' as const,
      builds: [{ build: '1', tag: 'V7.106.4-1', source: 'manual' as const, verified: true, repos: [{ repository_id: 'old', role: 'shell' as const, ref: 'old', expected_commit: COMMIT }] }],
    },
    {
      platform: 'android' as const,
      product_line: 'xueersi' as const,
      version: '7.106.5',
      form_factor: 'phone' as const,
      builds: [{ build: '2', tag: 'V7.106.5-2', source: 'manual' as const, verified: true, repos: [{ repository_id: 'new', role: 'shell' as const, ref: 'new', expected_commit: COMMIT }] }],
    },
  ];
  const selected = selectVersionRegistryEntry(entries, {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: 'phone',
  });
  assert.equal(selected.entry.version, '7.106.5');
  assert.equal(selected.repositories[0]?.repository_id, 'new');
});

test('先按明确形态筛选再选择最新版本，避免 HD 误绑定手机源码', () => {
  const entries = [
    {
      platform: 'android' as const,
      product_line: 'xueersi' as const,
      version: '7.106.5',
      form_factor: 'phone' as const,
      builds: [{ build: '2', tag: 'phone-new', source: 'manual' as const, verified: true, repos: [{ repository_id: 'phone', role: 'shell' as const, ref: 'phone-new', expected_commit: COMMIT }] }],
    },
    {
      platform: 'android' as const,
      product_line: 'xueersi' as const,
      version: '5.106.5',
      form_factor: 'pad' as const,
      builds: [{ build: '1', tag: 'pad-old', source: 'manual' as const, verified: true, repos: [{ repository_id: 'pad', role: 'shell' as const, ref: 'pad-old', expected_commit: COMMIT }] }],
    },
  ];
  const selected = selectVersionRegistryEntry(entries, {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: 'pad',
  });
  assert.equal(selected.entry.form_factor, 'pad');
  assert.equal(selected.repositories[0]?.repository_id, 'pad');
});

test('未说明形态且同一产品线有手机和平板版本时拒绝猜测', () => {
  const entries = [
    {
      platform: 'android' as const,
      product_line: 'xueersi' as const,
      version: '7.106.5',
      form_factor: 'phone' as const,
      builds: [{ build: '1', tag: 'phone', source: 'manual' as const, verified: true, repos: [{ repository_id: 'phone', role: 'shell' as const, ref: 'phone', expected_commit: COMMIT }] }],
    },
    {
      platform: 'android' as const,
      product_line: 'xueersi' as const,
      version: '5.106.5',
      form_factor: 'pad' as const,
      builds: [{ build: '1', tag: 'pad', source: 'manual' as const, verified: true, repos: [{ repository_id: 'pad', role: 'shell' as const, ref: 'pad', expected_commit: COMMIT }] }],
    },
  ];
  assert.throws(
    () => selectVersionRegistryEntry(entries, { platform: 'android', productLine: 'xueersi' }),
    (error: unknown) => error instanceof VersionRegistryError && error.code === 'version_ambiguous',
  );
  assert.equal(selectVersionRegistryEntry(entries, {
    platform: 'android', productLine: 'xueersi', formFactor: 'phone',
  }).entry.form_factor, 'phone');
});

test('多仓登记要求唯一 shell、安全挂载路径和不重复挂载点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'version-registry-multi-'));
  try {
    await mkdir(join(root, 'ios'));
    await writeFile(join(root, 'ios', 'xueersi.yaml'), `
- version: 7.106.5
  builds:
    - tag: release
      source: manual
      verified: true
      repos:
        - repository_id: shell
          role: shell
          ref: release
          expected_commit: ${COMMIT}
        - repository_id: component
          role: component
          mount_path: ../outside
          ref: release
          expected_commit: ${COMMIT}
        - repository_id: config
          role: config
          mount_path: components
          ref: release
          expected_commit: ${COMMIT}
        - repository_id: duplicate
          role: component
          mount_path: components
          ref: release
          expected_commit: ${COMMIT}
`);
    await assert.rejects(loadVersionRegistry(root), (error: unknown) =>
      error instanceof VersionRegistryError && error.code === 'invalid_registry');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
