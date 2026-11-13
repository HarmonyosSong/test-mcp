import assert from 'node:assert/strict';
import test from 'node:test';

import { ClientObservationGate } from '../src/orchestration/client-observation-gate.js';

function executable<T>(run: (...args: any[]) => T) {
  return { execute: run };
}

test('observe→source 门禁拒绝过早读取源码，日志查询后才放行', async () => {
  const calls: string[] = [];
  const gate = new ClientObservationGate(['observe', 'source'], true);
  const read = gate.wrap('read_project_file', executable(async () => {
    calls.push('source');
    return { content: 'source' };
  }));
  const resolve = gate.wrap('resolve_log_target', executable(async () => {
    calls.push('resolve');
    return { status: 'resolved', candidates: [{}] };
  }));
  const search = gate.wrap('search_cloud_logs', executable(async () => {
    calls.push('search');
    return { observation_status: 'correlated', entries: [{ entry_id: 'log-fixture' }] };
  }));

  await assert.rejects(read.execute!({}, {}), /client_observation_required/);
  assert.equal(gate.observationStatus, 'pending');
  await resolve.execute!({}, {});
  assert.equal(gate.sourceAllowed, false);
  await search.execute!({}, {});
  assert.equal(gate.observationStatus, 'completed');
  await read.execute!({}, {});
  assert.deepEqual(calls, ['resolve', 'search', 'source']);
});

test('目录不覆盖和日志查询失败允许降级，但不伪装成观察成功', async () => {
  for (const scenario of ['not_found', 'search_failed'] as const) {
    const gate = new ClientObservationGate(['observe', 'source'], true);
    const read = gate.wrap('search_project_text', executable(async () => ({ matches: [] })));
    if (scenario === 'not_found') {
      const resolve = gate.wrap('resolve_log_target', executable(async () => ({ status: 'not_found', candidates: [] })));
      await resolve.execute!({}, {});
    } else {
      const search = gate.wrap('search_cloud_logs', executable(async () => { throw new Error('schema mismatch'); }));
      await assert.rejects(search.execute!({}, {}), /schema mismatch/);
    }
    assert.equal(gate.observationStatus, 'degraded');
    assert.equal(gate.sourceAllowed, true);
    await read.execute!({}, {});
  }
});

test('目录歧义和普通 count 不会提前开放源码阶段', async () => {
  const gate = new ClientObservationGate(['observe', 'source'], true);
  const read = gate.wrap('list_project_files', executable(async () => []));
  const resolve = gate.wrap('resolve_log_target', executable(async () => ({ status: 'ambiguous', candidates: [{}, {}] })));
  const count = gate.wrap('count_cloud_logs', executable(async () => ({ total: 10 })));
  await resolve.execute!({}, {});
  await count.execute!({}, {});
  assert.equal(gate.observationStatus, 'pending');
  await assert.rejects(read.execute!({}, {}), /client_observation_required/);
});

test('代码导航工具受 observe→source 门禁约束，现场降级后允许继续导航', async () => {
  const navigationTools = ['search_code_symbols', 'get_code_outline', 'trace_code_path'];
  const gate = new ClientObservationGate(['observe', 'source'], true);
  let navigationCalls = 0;
  for (const name of navigationTools) {
    const navigation = gate.wrap(name, executable(async () => {
      navigationCalls += 1;
      return { status: 'navigation_hint' };
    }));
    await assert.rejects(navigation.execute!({}, {}), /client_observation_required/);
  }
  assert.equal(navigationCalls, 0);

  const resolve = gate.wrap('resolve_log_target', executable(async () => ({ status: 'not_found', candidates: [] })));
  await resolve.execute!({}, {});
  assert.equal(gate.observationStatus, 'degraded');
  for (const name of navigationTools) {
    const navigation = gate.wrap(name, executable(async () => {
      navigationCalls += 1;
      return { status: 'navigation_hint' };
    }));
    await navigation.execute!({}, {});
  }
  assert.equal(navigationCalls, navigationTools.length);
});

test('用户粘贴 hilog 的解析可以完成现场观察阶段', async () => {
  const gate = new ClientObservationGate(['observe', 'source'], true);
  const parse = gate.wrap('parse_hilog', executable(async () => ({ entries: [] })));
  await parse.execute!({}, {});
  assert.equal(gate.observationStatus, 'completed');
  assert.equal(gate.sourceAllowed, true);
});

test('空结果和身份未匹配是已尝试未观察，发现到关联条目才完成观察', async () => {
  for (const result of [
    { observation_status: 'empty', entries: [] },
    { observation_status: 'uncorrelated', entries: [{ entry_id: 'other' }] },
  ]) {
    const gate = new ClientObservationGate(['observe', 'source'], true);
    const search = gate.wrap('search_cloud_logs', executable(async () => result));
    await search.execute!({}, {});
    assert.equal(gate.observationStatus, 'degraded');
    assert.equal(gate.sourceAllowed, true);
  }

  const gate = new ClientObservationGate(['observe', 'source'], true);
  const discover = gate.wrap('discover_client_sessions', executable(async () => ({
    status: 'resolved',
    candidates: [{ entries: [{ entry_id: 'log-fixture' }] }],
  })));
  await discover.execute!({}, {});
  assert.equal(gate.observationStatus, 'completed');
});

test('设备发现无结果或降级时不伪装成成功观察', async () => {
  for (const status of ['not_found', 'not_covered', 'degraded']) {
    const gate = new ClientObservationGate(['observe', 'source'], true);
    const discover = gate.wrap('discover_client_sessions', executable(async () => ({ status, candidates: [] })));
    await discover.execute!({}, {});
    assert.equal(gate.observationStatus, 'degraded');
  }
});

test('lookup_learner 成功不算完成现场观察；失败才降级放行', async () => {
  const pending = new ClientObservationGate(['observe', 'source'], true);
  const ok = pending.wrap('lookup_learner', executable(async () => ({
    status: 'ok',
    learner: { uid: '1', card: '184010299547' },
  })));
  await ok.execute!({ learner_id: '184010299547' }, {});
  assert.equal(pending.observationStatus, 'pending');

  const degraded = new ClientObservationGate(['observe', 'source'], true);
  const miss = degraded.wrap('lookup_learner', executable(async () => ({
    status: 'not_found',
    learner: null,
  })));
  await miss.execute!({ learner_id: '184010299547' }, {});
  assert.equal(degraded.observationStatus, 'degraded');
  assert.equal(degraded.sourceAllowed, true);
});

test('旧调用和日志能力不可用保持兼容，不增加虚假的门禁', async () => {
  for (const gate of [
    new ClientObservationGate(undefined, true),
    new ClientObservationGate(['observe', 'source'], false),
    new ClientObservationGate(['observe'], true),
  ]) {
    assert.equal(gate.observationStatus, 'not_required');
    const read = gate.wrap('read_project_file', executable(async () => ({ content: 'source' })));
    await read.execute!({}, {});
  }
});
