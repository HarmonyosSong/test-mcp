import assert from 'node:assert/strict';
import test from 'node:test';

import { ObservationRegistry } from '../src/diagnosis/observations.js';
import { RoundGuard } from '../src/diagnosis/round-guard.js';

function fakeTool(impl: (args: Record<string, unknown>) => Promise<unknown> | unknown) {
  return {
    execute: async (args: Record<string, unknown>, _context?: unknown) => impl(args),
  };
}

function guardWith(overrides: Partial<ConstructorParameters<typeof RoundGuard>[0]> = {}) {
  return new RoundGuard({
    observations: new ObservationRegistry(),
    ...overrides,
  });
}

test('串行 dispatch：并发调用按序执行', async () => {
  const guard = guardWith();
  const order: string[] = [];
  const tool = guard.wrap(fakeTool(async (args) => {
    order.push(`start:${String(args.tag)}`);
    await new Promise((resolve) => setTimeout(resolve, Number(args.delay)));
    order.push(`end:${args.tag}`);
    return { ok: true };
  }), 'test', 'some_tool');

  await Promise.all([
    tool.execute({ tag: 'a', delay: 30 }, undefined),
    tool.execute({ tag: 'b', delay: 5 }),
  ]);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('可复用工具同签名命中缓存；观测 ID 失效时真重读', async () => {
  const observations = new ObservationRegistry();
  const guard = guardWith({ observations });
  let calls = 0;
  const tool = guard.wrap(fakeTool(async () => {
    calls += 1;
    return { path: 'src/a.ets', start_line: 1, content: 'v1' };
  }), 'repository', 'read_project_file');

  await tool.execute({ relative_path: 'src/a.ets' }, undefined);
  const second = await tool.execute({ relative_path: 'src/a.ets' }, undefined) as { result: unknown };
  assert.equal(calls, 1, '第二次命中缓存');
  assert.equal(guard.stats.cacheHits, 1);
  assert.ok(second && typeof second === 'object' && 'evidence_refs' in second, '缓存形状保留 evidence_refs 包装');

  // 新注册表（模拟跨轮 restore 丢失）→ 缓存的证据 ID 不再存在 → 真重读。
  const freshGuard = guardWith({ observations: new ObservationRegistry() });
  const refetched = freshGuard.wrap(fakeTool(async () => {
    calls += 1;
    return { path: 'src/a.ets', start_line: 1, content: 'v1' };
  }), 'repository', 'read_project_file');
  await refetched.execute({ relative_path: 'src/a.ets' }, undefined);
  assert.equal(calls, 2);
});

test('同签名失败禁原样重试；transient 失败允许一次', async () => {
  const guard = guardWith();
  let calls = 0;
  const failing = guard.wrap(fakeTool(async () => {
    calls += 1;
    throw new Error('参数错误');
  }), 'repository', 'read_project_file');
  await assert.rejects(failing.execute({ relative_path: 'x' }, undefined), /参数错误/);
  await assert.rejects(failing.execute({ relative_path: 'x' }, undefined), /禁止原样重试/);
  assert.equal(calls, 1);

  let transientCalls = 0;
  const transient = guard.wrap(fakeTool(async () => {
    transientCalls += 1;
    if (transientCalls === 1) {
      const error = new Error('上游超时') as Error & { transient: boolean };
      error.transient = true;
      throw error;
    }
    return { ok: true };
  }), 'repository', 'parse_hilog');
  await assert.rejects(transient.execute({ log_text: 'x' }, undefined), /上游超时/);
  await transient.execute({ log_text: 'x' }, undefined);
  assert.equal(transientCalls, 2);
  // 重试成功后同签名命中缓存（可复用工具），不再真实执行。
  const third = await transient.execute({ log_text: 'x' }, undefined) as { ok?: boolean; result?: { ok?: boolean } };
  assert.equal(transientCalls, 2);
  assert.equal(third.ok ?? third.result?.ok, true);
});

test('连续无进展只提醒不阻断（去编排核心差异）', async () => {
  const guard = guardWith({ noProgressNudgeAt: 3 });
  // 同一签名命中缓存 → 无进展；即便绕过缓存（不同参数返回相同内容）也只提醒。
  let calls = 0;
  const tool = guard.wrap(fakeTool(async (args) => {
    calls += 1;
    return { matches: [], truncated: false, cursor: String(args.cursor ?? '') };
  }), 'repository', 'search_project_text');

  let lastResult: Record<string, unknown> = {};
  for (let index = 0; index < 5; index += 1) {
    lastResult = await tool.execute({ query: 'q', cursor: `c${index}` }, undefined) as Record<string, unknown>;
  }
  assert.equal(calls, 5, '无进展不再硬阻断，调用仍然执行');
  assert.ok(guard.stats.nudges > 0, '达到阈值后注入提醒');
  assert.match(String(lastResult.round_guard_reminder ?? ''), /未取得新的有效信息/);
});

test('软时限到期后工具关闭并提示收尾，不抛错、不计失败', async () => {
  const guard = guardWith({ softDeadlineAt: Date.now() - 1_000 });
  assert.equal(guard.pastSoftDeadline, true);
  const tool = guard.wrap(fakeTool(async () => ({ ok: true })), 'repository', 'read_project_file');
  const result = await tool.execute({ relative_path: 'a' }, undefined) as Record<string, unknown>;
  assert.equal(result.soft_closed, true);
  assert.match(String(result.message), /收尾/);
  assert.equal(guard.stats.failures, 0);
  assert.equal(guard.stats.softClosed, true);
});

test('调用与失败硬上限仍然兜底', async () => {
  const guard = guardWith({ callLimit: 2, failureLimit: 1 });
  const ok = guard.wrap(fakeTool(async () => ({ ok: true })), 'learner', 'lookup_learner');
  await ok.execute({ learner_id: '1' }, undefined);
  await ok.execute({ learner_id: '2' }, undefined);
  await assert.rejects(ok.execute({ learner_id: '3' }, undefined), /120|上限/);

  const failingGuard = guardWith({ failureLimit: 1 });
  const failing = failingGuard.wrap(fakeTool(async (args) => {
    throw new Error(`boom ${String(args.n)}`);
  }), 'learner', 'lookup_learner');
  await assert.rejects(failing.execute({ n: 1 }, undefined), /boom 1/);
  await assert.rejects(failing.execute({ n: 2 }, undefined), /失败次数已达到/);
});

test('观测登记经过 RoundGuard 进入注册表（evidence_refs 包装）', async () => {
  const observations = new ObservationRegistry();
  const guard = guardWith({ observations });
  const tool = guard.wrap(fakeTool(async () => ({
    path: 'src/b.ets', start_line: 3, content: 'let x = 1',
  })), 'repository', 'read_project_file');
  const result = await tool.execute({ relative_path: 'src/b.ets' }, undefined) as {
    evidence_refs: Array<{ id: string }>;
  };
  assert.equal(result.evidence_refs.length, 1);
  assert.equal(observations.has(result.evidence_refs[0]!.id), true);
});
