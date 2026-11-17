import assert from "node:assert/strict";
import test from "node:test";

import { ObservationRegistry } from "../src/diagnosis/observations.js";
import { RoundGuard } from "../src/diagnosis/round-guard.js";
import { CodeLocatorRegistry } from "../src/diagnosis/locator-guidance.js";

// 去编排化后的预算护栏语义：withToolBudget → RoundGuard。
// 核心差异：连续无进展只注入提醒文本（不硬阻断），报告提交豁免随 submit 工具一起退役。

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

test("导航工具默认参数归一化后命中同一缓存签名", async () => {
  const guard = guardWith();
  const calls = new Map<string, number>();
  const cases = [
    {
      name: "search_code_symbols",
      first: { query: "refresh" },
      repeated: { query: "refresh", file_pattern: "**/*", limit: 20 },
    },
    {
      name: "get_code_outline",
      first: { relative_path: "src/Page.ets" },
      repeated: { relative_path: "src/Page.ets", limit: 100 },
    },
    {
      name: "trace_code_path",
      first: { function_name: "refresh" },
      repeated: { function_name: "refresh", direction: "inbound", depth: 1, limit: 20 },
    },
  ];

  for (const item of cases) {
    const tool = guard.wrap(
      fakeTool(async () => {
        calls.set(item.name, (calls.get(item.name) ?? 0) + 1);
        return { status: "navigation_hint", path: "src/Page.ets", symbol: "refresh" };
      }),
      "repository",
      item.name,
    );
    const first = await tool.execute(item.first, undefined);
    assert.deepEqual(await tool.execute(item.repeated, undefined), first);
  }

  assert.deepEqual([...calls], cases.map(({ name }) => [name, 1]));
  assert.equal(guard.stats.attempts, cases.length);
  assert.equal(guard.stats.cacheHits, cases.length);
});

test("导航失败抛回退提示并禁原样重试，文本检索兜底不受影响", async () => {
  for (const result of [
    { isError: true, content: [{ type: "text", text: "unavailable" }] },
    { status: "unavailable" },
  ]) {
    const observations = new ObservationRegistry();
    const guard = guardWith({ observations });
    let calls = 0;
    const navigation = guard.wrap(
      fakeTool(async () => {
        calls += 1;
        return result;
      }),
      "repository",
      "search_code_symbols",
    );
    await assert.rejects(navigation.execute({ query: "refresh" }, undefined), /search_project_text/);
    await assert.rejects(
      navigation.execute({ query: "refresh", file_pattern: "**/*", limit: 20 }, undefined),
      /禁止原样重试/,
    );
    assert.equal(calls, 1);
    assert.equal(guard.stats.failures, 1);

    const search = guard.wrap(
      fakeTool(async () => ({ matches: [{ path: "src/Page.ets", line: 1, content: "refresh()" }] })),
      "repository",
      "search_project_text",
    );
    await search.execute({ query: "refresh" }, undefined);
    assert.equal(observations.size, 1);
    assert.equal(guard.stats.attempts, 2);
  }
});

test("导航结果行去重计入无进展：达到阈值只提醒不阻断", async () => {
  for (const name of ["search_code_symbols", "get_code_outline", "trace_code_path"]) {
    const guard = guardWith();
    const empty = guard.wrap(
      fakeTool(async () => ({ navigation: { rows: [], query: "first" } })),
      "repository",
      name,
    );
    await empty.execute({ query: "first" }, undefined);

    let score = 0;
    let calls = 0;
    const repeated = guard.wrap(
      fakeTool(async () => {
        calls += 1;
        return {
          navigation: {
            callers: { groups: [{ file: "src/Page.ets", cols: ["name", "score"], rows: [["refresh", score++]] }] },
          },
        };
      }),
      "repository",
      name,
    );
    await repeated.execute({ query: "second" }, undefined);
    let last: Record<string, unknown> = {};
    for (const query of ["third", "fourth", "fifth", "sixth", "seventh"]) {
      last = (await repeated.execute({ query }, undefined)) as Record<string, unknown>;
    }
    assert.equal(calls, 6, "无进展不再硬阻断，调用始终执行");
    assert.ok(guard.stats.nudges > 0, "达到阈值后注入提醒文本");
    assert.match(String(last.round_guard_reminder ?? ""), /未取得新的有效信息/);
  }
});

test("locator 指引随知识命中注册，读过对应行后消失", async () => {
  const locators = new CodeLocatorRegistry();
  locators.register("`onShowFileSelector` is implemented in `entry/src/main/ets/Page.ets:163`.");
  assert.match(locators.hint("search onShowFileSelector") ?? "", /Page\.ets:163/);
  locators.markRead("entry/src/main/ets/Page.ets", 160, 170);
  assert.equal(locators.hint("search onShowFileSelector"), null);

  const guard = guardWith();
  const knowledge = guard.wrap(
    fakeTool(async () => "`onShowFileSelector` is implemented in `entry/src/main/ets/Page.ets:163`."),
    "knowledge",
    "lookup_issue",
  );
  await knowledge.execute({ query: "入口" }, undefined);

  const search = guard.wrap(
    fakeTool(async () => ({ matches: [{ path: "src/x.ets", line: 1, content: "x" }] })),
    "repository",
    "search_project_text",
  );
  // capture 包装形状为 {evidence_refs, result}：locator_hint 在 result 内侧。
  const withHint = (await search.execute({ query: "onShowFileSelector" }, undefined)) as {
    result: Record<string, unknown>;
  };
  assert.match(String(withHint.result.locator_hint ?? ""), /Page\.ets:163/);

  const read = guard.wrap(
    fakeTool(async () => ({ path: "entry/src/main/ets/Page.ets", start_line: 160, end_line: 170, content: "code" })),
    "repository",
    "read_project_file",
  );
  await read.execute({ relative_path: "entry/src/main/ets/Page.ets" }, undefined);
  const after = (await search.execute({ query: "onShowFileSelector", cursor: "2" }, undefined)) as {
    result: Record<string, unknown>;
  };
  assert.equal(after.result.locator_hint, undefined, "引用行已读过后不再附加定位提示");
});

test("缓存签名键：嵌套键序无关、数组序敏感、undefined 边界敏感", async () => {
  const guard = guardWith();
  let calls = 0;
  const tool = guard.wrap(
    fakeTool(async () => {
      calls += 1;
      return { value: calls };
    }),
    "knowledge",
    "lookup_issue",
  );
  await tool.execute({ nested: { b: 2, a: 1 }, list: [1, 2] }, undefined);
  await tool.execute({ nested: { a: 1, b: 2 }, list: [1, 2] }, undefined);
  await tool.execute({ nested: { a: 1, b: 2 }, list: [2, 1] }, undefined);
  await tool.execute({ nested: { a: 1, b: 2 }, list: [1, 2], extra: undefined }, undefined);
  assert.equal(calls, 3);
  assert.equal(guard.stats.cacheHits, 1);
});

test("串行 dispatch 下并发失败共享同一失败预算", async () => {
  const guard = guardWith({ failureLimit: 10 });
  let calls = 0;
  const tools = Array.from({ length: 16 }, (_, index) =>
    guard.wrap(
      fakeTool(async () => {
        calls += 1;
        throw new Error(`failure-${index}`);
      }),
      "knowledge",
      "lookup_issue",
    ),
  );
  await Promise.all(
    tools.map((tool, index) => tool.execute({ query: String(index) }, undefined).catch(() => undefined)),
  );
  assert.equal(guard.stats.failures, 10);
  assert.equal(calls, 10);
  assert.equal(guard.stats.blocked, 6);
});

test("非只读工具不进入缓存", async () => {
  const guard = guardWith();
  let writes = 0;
  const mutation = guard.wrap(
    fakeTool(async () => ++writes),
    "repository",
    "bind_repository",
  );
  await mutation.execute({}, undefined);
  await mutation.execute({}, undefined);
  assert.equal(writes, 2);
  assert.equal(guard.stats.cacheHits, 0);
});
