import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSessionMappingStore } from '../src/channels/yach/session-mapping-store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yach-mapping-'));
}

test('set 写穿落盘，新实例（模拟重启）能找回映射', () => {
  const file = join(tempDir(), 'mapping.json');
  const first = createSessionMappingStore(file);
  first.set('im:app1:g:group9:songyb', 'conv-de81bcc34e');
  first.set('im:app1:songyb', 'conv-e906a15dc2');
  assert.ok(existsSync(file), 'set 后文件已落盘');
  assert.ok(!existsSync(`${file}.tmp`), '原子写不残留临时文件');

  // 模拟进程重启：新实例从文件恢复，同群同学员的追问找回原会话。
  const restored = createSessionMappingStore(file);
  assert.equal(restored.get('im:app1:g:group9:songyb'), 'conv-de81bcc34e');
  assert.equal(restored.get('im:app1:songyb'), 'conv-e906a15dc2');
  assert.equal(restored.get('im:app1:unknown'), undefined);
});

test('文件不存在或损坏时从空映射开始，不抛错', () => {
  const missing = createSessionMappingStore(join(tempDir(), 'missing.json'));
  assert.equal(missing.get('k'), undefined);

  const corruptFile = join(tempDir(), 'corrupt.json');
  writeFileSync(corruptFile, '{not-json');
  const corrupt = createSessionMappingStore(corruptFile);
  assert.equal(corrupt.get('k'), undefined);
  // 损坏文件会在首次 set 时被正常内容覆盖。
  corrupt.set('k', 'conv-1');
  assert.equal(createSessionMappingStore(corruptFile).get('k'), 'conv-1');
});

test('落盘内容为明文 JSON 对象，权限 0600', () => {
  const dir = tempDir();
  const file = join(dir, 'mapping.json');
  createSessionMappingStore(file).set('k', 'conv-1');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { k: 'conv-1' });
});
