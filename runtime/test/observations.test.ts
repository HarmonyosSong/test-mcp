import assert from 'node:assert/strict';
import test from 'node:test';

import { ObservationRegistry } from '../src/diagnosis/observations.js';

function captureRead(registry: ObservationRegistry, path: string, content: string) {
  return registry.capture('read_project_file', { relative_path: path }, {
    path,
    start_line: 1,
    content,
  }) as { evidence_refs: Array<{ id: string; kind: string; location: string }>; result: unknown };
}

test('观测 ID 由内容哈希派生：同内容同 ID，跨 restore 稳定', () => {
  const first = new ObservationRegistry();
  const result = { path: 'src/a.ets', start_line: 8, content: 'throw new Error("boom")' };
  const captured = first.capture('read_project_file', { relative_path: 'src/a.ets' }, result) as {
    evidence_refs: Array<{ id: string }>; result: unknown;
  };
  const id = captured.evidence_refs[0]!.id;
  assert.match(id, /^ev-[0-9a-f]{16}$/);
  assert.deepEqual(captured.result, result);
  assert.equal(first.get(id)?.location, 'src/a.ets:8');

  const restored = ObservationRegistry.restore(first.snapshot());
  assert.equal(restored.has(id), true);
  assert.equal(restored.get(id)?.kind, 'source');

  // 与同内容在全新注册表中生成的 ID 一致（内容哈希契约，与旧 EvidenceLedger 相同算法）。
  const fresh = new ObservationRegistry();
  const again = fresh.capture('read_project_file', { relative_path: 'src/a.ets' }, result) as {
    evidence_refs: Array<{ id: string }>;
  };
  assert.equal(again.evidence_refs[0]?.id, id);
});

test('非观测工具结果原样透传，不登记', () => {
  const registry = new ObservationRegistry();
  const payload = { body: 'knowledge text' };
  assert.deepEqual(registry.capture('get_knowledge_entry', {}, payload), payload);
  assert.equal(registry.size, 0);
});

test('parse_hilog 只登记用户输入中实际出现的日志', () => {
  const pasted = 'ERROR at ohos.permission xxx';
  const registry = new ObservationRegistry({ inputTexts: [`用户粘贴：${pasted}`] });
  const rejected = registry.capture('parse_hilog', { log_text: '模型自编的日志' }, { error_lines: [] }) as {
    evidence_refs: unknown[]; limitation?: string;
  };
  assert.equal(rejected.evidence_refs.length, 0);
  assert.match(rejected.limitation ?? '', /未对应已提供的日志/);

  const accepted = registry.capture('parse_hilog', { log_text: pasted }, {
    error_lines: [{ content: 'ERROR at ohos.permission xxx', path: 'pasted-hilog', line: 1 }],
  }) as { evidence_refs: Array<{ id: string; kind: string }> };
  assert.equal(accepted.evidence_refs.length, 1);
  assert.equal(accepted.evidence_refs[0]?.kind, 'log');
});

test('远程日志：未关联身份条目不登记；关联条目保留 observation_context 并注册别名', () => {
  const registry = new ObservationRegistry();
  const uncorrelated = registry.capture('search_cloud_logs', {}, {
    entries: [{ excerpt: 'no binding', observation_context: { service_binding: { status: 'pending' }, matched_identifiers: [] } }],
  }) as { evidence_refs: unknown[]; uncorrelated_entries_rejected?: number; limitation?: string };
  assert.equal(uncorrelated.evidence_refs.length, 0);
  assert.equal(uncorrelated.uncorrelated_entries_rejected, 1);
  assert.match(uncorrelated.limitation ?? '', /未完成当前学员身份匹配/);

  const correlated = registry.capture('search_cloud_logs', {}, {
    entries: [{
      excerpt: 'FATAL: xts crash',
      location: 'sls://store/app#log-abcdef',
      observation_context: {
        entry_id: 'log-abcdef',
        store_id: 'store-1',
        appid: 'app-1',
        start: '2026-11-16 10:00:00',
        end: '2026-11-16 10:05:00',
        page: 1,
        service_binding: { status: 'confirmed' },
        matched_identifiers: ['uid:123'],
        observed_platform: 'harmony',
      },
    }],
  }) as { evidence_refs: Array<{ id: string; observation_context?: Record<string, unknown> }> };
  assert.equal(correlated.evidence_refs.length, 1);
  const entry = correlated.evidence_refs[0]!;
  assert.equal(registry.get(entry.id)?.observation_context?.observed_platform, 'harmony');
  assert.equal(registry.has('log-abcdef'), true, '日志条目别名可解析');
  assert.equal(registry.has('ev-abcdef'), true, 'ev- 派生别名可解析');
});

test('快照只存元数据：无正文、无淘汰；条目 append-only 不"过期"', () => {
  const registry = new ObservationRegistry();
  captureRead(registry, 'src/a.ets', 'content A');
  captureRead(registry, 'src/b.ets', 'content B');
  const snapshot = registry.snapshot();
  assert.equal(snapshot.registry_version, 1);
  assert.equal(snapshot.entries.length, 2);
  const first = snapshot.entries[0]!;
  assert.deepEqual(Object.keys(first).sort(), ['id', 'kind', 'location', 'source']);
  // 没有任何淘汰：再次登记更多条目后旧的仍然可查。
  for (let index = 0; index < 5; index += 1) captureRead(registry, `src/f${index}.ets`, `c${index}`);
  assert.equal(registry.has(snapshot.entries[0]!.id), true);
});

test('兼容读取旧 EvidenceLedger（ledger_version=2）快照：只取元数据', () => {
  const legacy = {
    ledger_version: 2,
    max_entries: 300,
    max_current_turn: 1000,
    max_current_turn_bytes: 4194304,
    texts: { 'ev-abc123abc123abc1': '原文正文' },
    evicted: { 'ev-old0old0old0old': 'src/gone.ets:1' },
    entries: [
      {
        id: 'ev-abc123abc123abc1',
        kind: 'log',
        source: 'logcenter:search_cloud_logs',
        location: 'sls://s/a#log-x',
        excerpt: '原文正文',
        supports: '…',
        observation_context: { observed_platform: 'harmony', matched_identifiers: ['uid:1'] },
      },
    ],
  };
  const registry = ObservationRegistry.restore(legacy);
  assert.equal(registry.has('ev-abc123abc123abc1'), true);
  const entry = registry.get('ev-abc123abc123abc1');
  assert.equal(entry?.kind, 'log');
  assert.equal(entry?.observation_context?.observed_platform, 'harmony');
  assert.equal(registry.has('ev-old0old0old0old'), false, '旧墓碑语义不再复活，只是无此 ID');
});

test('用户引用 ID 由内容哈希派生，has() 覆盖', () => {
  const registry = new ObservationRegistry({ inputTexts: ['用户说：提交作业失败'] });
  const refs = registry.registerUserTexts();
  assert.equal(refs.length, 1);
  assert.match(refs[0]!.id, /^ev-user-[0-9a-f]{12}$/);
  assert.equal(registry.has(refs[0]!.id), true);
  // restore 后用同样 inputTexts 重注册，ID 一致。
  const restored = ObservationRegistry.restore(registry.snapshot(), { inputTexts: ['用户说：提交作业失败'] });
  assert.equal(restored.registerUserTexts()[0]?.id, refs[0]!.id);
});

test('多仓绑定的源码归属：不属于任何挂载点的路径被拒绝', () => {
  const registry = new ObservationRegistry({
    sourceContexts: [{
      repository_id: 'repo-shell',
      repository_name: 'xes-harmony-shell',
      requested_ref: 'v3.2.1',
      resolved_commit: 'abc123',
      role: 'shell',
      mount_path: 'shell',
    }],
  });
  const rejected = captureRead(registry, 'other/x.ets', 'x') as {
    evidence_refs: unknown[]; source_paths_rejected?: number; limitation?: string;
  };
  assert.equal(rejected.evidence_refs.length, 0);
  assert.equal(rejected.source_paths_rejected, 1);
  const accepted = captureRead(registry, 'shell/src/a.ets', 'a');
  assert.equal(accepted.evidence_refs.length, 1);
  assert.equal(accepted.evidence_refs[0]?.kind, 'source');
});
