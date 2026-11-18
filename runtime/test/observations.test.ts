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

test('对照端观测按 compareSourceContexts 归因：同路径同内容两侧 ev-ID 不同', () => {
  const incident = [{
    repository_id: 'repo-harmony', repository_name: 'xesapp-harmony',
    requested_ref: '7.106.0', resolved_commit: 'harmonycommit', role: 'shell' as const, mount_path: '',
  }];
  const compare = [{
    repository_id: 'repo-ios', repository_name: 'xesapp-ios',
    requested_ref: 'xueersi_v7.106.0_1000_20261101', resolved_commit: 'ioscommit', role: 'shell' as const, mount_path: '',
  }];
  const registry = new ObservationRegistry({
    sourceContexts: incident,
    compareSourceContexts: () => compare,
  });
  const result = { path: 'src/order/Page', start_line: 10, content: 'if (kuabaoType === 3)' };
  const incidentCapture = registry.capture('read_project_file', { relative_path: 'src/order/Page' }, result) as {
    evidence_refs: Array<{ id: string; source_context?: { repository_id: string; resolved_commit: string } }>;
  };
  const compareCapture = registry.capture('read_project_file', { relative_path: 'src/order/Page', target: 'compare' }, result) as {
    evidence_refs: Array<{ id: string; source_context?: { repository_id: string; resolved_commit: string } }>;
  };
  const incidentRef = incidentCapture.evidence_refs[0]!;
  const compareRef = compareCapture.evidence_refs[0]!;
  assert.notEqual(incidentRef.id, compareRef.id);
  assert.equal(incidentRef.source_context?.repository_id, 'repo-harmony');
  assert.equal(compareRef.source_context?.repository_id, 'repo-ios');
  assert.equal(compareRef.source_context?.resolved_commit, 'ioscommit');
  assert.equal(registry.has(compareRef.id), true);
});

test('target=incident 显式与省略同 ID（target 不进入内容哈希）', () => {
  const result = { path: 'src/a.ets', start_line: 1, content: 'let x = 1' };
  const implicit = new ObservationRegistry();
  const explicit = new ObservationRegistry();
  const a = implicit.capture('read_project_file', { relative_path: 'src/a.ets' }, result) as {
    evidence_refs: Array<{ id: string }>;
  };
  const b = explicit.capture('read_project_file', { relative_path: 'src/a.ets', target: 'incident' }, result) as {
    evidence_refs: Array<{ id: string }>;
  };
  assert.equal(a.evidence_refs[0]?.id, b.evidence_refs[0]?.id);
});

test('对照端未绑定（空对照上下文）时观测被拒绝并给出对照端提示', () => {
  const registry = new ObservationRegistry({
    sourceContexts: [{
      repository_id: 'repo-harmony', repository_name: 'xesapp-harmony',
      requested_ref: '7.106.0', resolved_commit: 'harmonycommit', role: 'shell' as const, mount_path: '',
    }],
    compareSourceContexts: () => [],
  });
  const captured = registry.capture('read_project_file', { relative_path: 'src/a.ets', target: 'compare' }, {
    path: 'src/a.ets', start_line: 1, content: 'let x = 1',
  }) as { evidence_refs: unknown[]; source_paths_rejected?: number; limitation?: string };
  assert.equal(captured.evidence_refs.length, 0);
  assert.equal(captured.source_paths_rejected, 1);
  assert.match(String(captured.limitation), /对照端/);
  // 关键：空对照上下文下不得误归因到事故端仓库
  assert.equal(registry.size, 0);
});

test('对照端 thunk 延迟读取：注册表构造后才发生的对照绑定也能正确归因', () => {
  // 模拟轮内时序：注册表在轮首构造，对照绑定由 prepare_source 在轮内写入会话。
  const state: {
    repos: Array<{
      repository_id: string; repository_name: string; requested_ref: string;
      resolved_commit: string; role: 'shell'; mount_path: string;
    }>;
  } = { repos: [] };
  const registry = new ObservationRegistry({ compareSourceContexts: () => state.repos });
  state.repos = [{
    repository_id: 'repo-ios', repository_name: 'xesapp-ios',
    requested_ref: 'ref', resolved_commit: 'ioscommit', role: 'shell', mount_path: '',
  }];
  const captured = registry.capture('search_project_text', { query: 'kuabao', target: 'compare' }, {
    matches: [{ path: 'Classes/Order.m', line: 7, content: 'kuabaoType == 3' }],
  }) as { evidence_refs: Array<{ id: string; source_context?: { repository_id: string } }> };
  assert.equal(captured.evidence_refs[0]?.source_context?.repository_id, 'repo-ios');
});

test('协查完成态结论登记为 external 观测：可引用、参与存在性校验', () => {
  const registry = new ObservationRegistry();
  const result = {
    status: 'completed',
    conclusion: '服务端在 v3.2 引入该校验，多退少补场景返回 kuabaoStatus=1',
    consultation_id: 'consult-abc',
    truncated: false,
  };
  const captured = registry.capture('consult_compass', { question: '查校验逻辑' }, result) as {
    evidence_refs: Array<{ id: string; kind: string; source: string; observation_context?: Record<string, unknown> }>;
    result: unknown;
  };
  assert.equal(captured.evidence_refs.length, 1);
  const ref = captured.evidence_refs[0]!;
  assert.match(ref.id, /^ev-[0-9a-f]{16}$/);
  assert.equal(ref.kind, 'external');
  assert.equal(ref.source, 'compass:consult_compass');
  assert.equal(ref.observation_context?.consultation_id, 'consult-abc');
  assert.equal(registry.has(ref.id), true);
  assert.deepEqual(captured.result, result, '原始结果原样内嵌返回');
});

test('协查未完成态不登记：failed/budget_exhausted/缺文本原样透传', () => {
  const registry = new ObservationRegistry();
  for (const result of [
    { status: 'failed', conclusion: '半截文本', consultation_id: 'c1' },
    { status: 'budget_exhausted' },
    { status: 'completed', conclusion: '   ', consultation_id: 'c2' },
    { status: 'completed', consultation_id: 'c3' },
  ]) {
    const captured = registry.capture('consult_compass', { question: 'q' }, result);
    assert.deepEqual(captured, result);
  }
  assert.equal(registry.size, 0);
});
