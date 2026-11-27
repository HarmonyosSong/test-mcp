import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createYachContactResolver } from '../src/channels/yach/contacts.js';

/** 写一个假 yach-cli：首行模拟升级提示，第二行输出固定 JSON（验证 parseCliJson 容忍噪声行）。 */
async function fakeCli(directory: string, name: string | null): Promise<string> {
  const path = `${directory}/fake-yach-cli.sh`;
  const body = name
    ? `echo "yach-cli: new version available";\necho '{"ok":true,"data":{"obj":{"name":"${name}"}}}'`
    : `echo '{"ok":false,"error":{"message":"not found"}}'`;
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

test('工号→姓名：解析成功并落磁盘缓存，二次调用命中缓存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yach-contacts-'));
  try {
    const cli = await fakeCli(directory, '宋一博');
    const cachePath = join(directory, 'cache.json');
    const resolver = createYachContactResolver({ cliPath: cli, cachePath });

    const first = await resolver.resolveNames(['V0047863', ' V0047863 ', '']);
    assert.equal(first.get('V0047863'), '宋一博');
    assert.equal(first.size, 1);
    // 缓存已落盘
    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, string>;
    assert.equal(cache['V0047863'], '宋一博');

    // 换成一个会报错的 cli：命中缓存应照常返回
    const badCli = join(directory, 'missing-cli');
    const cached = createYachContactResolver({ cliPath: badCli, cachePath });
    const second = await cached.resolveNames(['V0047863']);
    assert.equal(second.get('V0047863'), '宋一博');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('工号→姓名：查不到返回空且不写缓存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yach-contacts-miss-'));
  try {
    const cli = await fakeCli(directory, null);
    const cachePath = join(directory, 'cache.json');
    const resolver = createYachContactResolver({ cliPath: cli, cachePath });
    const result = await resolver.resolveNames(['nobody']);
    assert.equal(result.size, 0);
    // 不写缓存文件（无成功结果）
    await assert.rejects(readFile(cachePath, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
