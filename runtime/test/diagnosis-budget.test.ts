import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceLedger } from "../src/diagnosis/evidence.js";
import { withToolBudget } from "../src/diagnosis/agent.js";
import { CodeLocatorRegistry } from "../src/diagnosis/locator-guidance.js";

const wrap = (...args: Parameters<typeof withToolBudget>) =>
  withToolBudget(...args) as {
    execute?: (
      args: Record<string, unknown>,
      context: unknown,
    ) => Promise<unknown>;
  };

function setup() {
  const ledger = new EvidenceLedger();
  const budget = {
    attempts: 0,
    failures: 0,
    cacheHits: 0,
    consecutiveCacheHits: 0,
    blocked: 0,
    reportAttempts: 0,
    cache: new Map<string, unknown>(),
  };
  return { ledger, budget };
}

test("caches only structurally identical successful tool calls and reports reuse accurately", async () => {
  const { ledger, budget } = setup();
  let calls = 0;
  const wrapped = wrap(
    { execute: async () => ({ matches: [], next_cursor: null }) },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  const first = await wrapped.execute!(
    { filters: { b: 2, a: 1 }, query: "one" },
    {},
  );
  const repeated = await wrapped.execute!(
    { query: "one", filters: { a: 1, b: 2 } },
    {},
  );
  assert.deepEqual(repeated, first);
  assert.equal(budget.attempts, 1);
  assert.equal(budget.cacheHits, 1);
  assert.equal(budget.failures, 0);

  const different = wrap(
    {
      execute: async () => {
        calls += 1;
        return { matches: [], next_cursor: null };
      },
    },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await different.execute!({ filters: { b: 2, a: 1 }, query: "two" }, {});
  assert.equal(calls, 1);
  assert.equal(budget.attempts, 2);
});

test("counts failed executions once, does not cache failures, and resets the no-progress streak", async () => {
  const { ledger, budget } = setup();
  const failing = wrap(
    {
      execute: async () => {
        throw new Error("offline");
      },
    },
    "mcp",
    "lookup_issue",
    ledger,
    budget,
  );
  await assert.rejects(failing.execute!({}, {}), /offline/);
  assert.equal(budget.failures, 1);
  await assert.rejects(failing.execute!({}, {}), /禁止原样重试/);
  assert.equal(budget.failures, 1);

  let query = "x";
  const ok = wrap(
    {
      execute: async () => ({
        matches: [{ path: query, line: 1 }],
        next_cursor: null,
      }),
    },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await ok.execute!({ query: "x" }, {});
  await ok.execute!({ query: "x" }, {});
  assert.equal(budget.consecutiveCacheHits, 1);
  query = "y";
  const fresh = wrap(
    {
      execute: async () => ({
        matches: [{ path: query, line: 1 }],
        next_cursor: null,
      }),
    },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await fresh.execute!({ query: "y" }, {});
  assert.equal(budget.consecutiveCacheHits, 0);
});

test("retries an identical tool call once only when the upstream marks the failure transient", async () => {
  const { ledger, budget } = setup();
  let calls = 0;
  const transient = wrap(
    {
      execute: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("temporary timeout"), {
            transient: true,
          });
        return { value: "ok" };
      },
    },
    "mcp",
    "lookup_issue",
    ledger,
    budget,
  );
  await assert.rejects(
    transient.execute!({ query: "x" }, {}),
    /temporary timeout/,
  );
  assert.deepEqual(await transient.execute!({ query: "x" }, {}), {
    value: "ok",
  });
  assert.equal(calls, 2);
  assert.deepEqual(await transient.execute!({ query: "x" }, {}), {
    value: "ok",
  });
  assert.equal(calls, 2);
});

test("counts empty and duplicate search results as no progress", async () => {
  const { ledger, budget } = setup();
  const empty = wrap(
    { execute: async () => ({ matches: [], next_cursor: null }) },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await empty.execute!({ query: "first" }, {});
  assert.equal(budget.consecutiveCacheHits, 1);
  const result = {
    matches: [{ path: "src/Page.ets", line: 12 }],
    next_cursor: null,
  };
  const search = wrap(
    { execute: async () => result },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await search.execute!({ query: "second" }, {});
  assert.equal(budget.consecutiveCacheHits, 0);
  await search.execute!({ query: "third" }, {});
  assert.equal(budget.consecutiveCacheHits, 1);
});

test("serializes concurrent tool execution under one shared failure budget", async () => {
  const { ledger, budget } = setup();
  let calls = 0;
  const tools = Array.from({ length: 16 }, (_, index) =>
    wrap(
      {
        execute: async () => {
          calls += 1;
          throw new Error(`failure-${index}`);
        },
      },
      "mcp",
      "lookup_issue",
      ledger,
      budget,
    ),
  );
  await Promise.all(
    tools.map((tool, index) =>
      tool.execute!({ query: String(index) }, {}).catch(() => undefined),
    ),
  );
  assert.equal(budget.failures, 10);
  assert.equal(calls, 10);
  assert.equal(budget.blocked, 6);
});

test("locator guidance points to indexed source and disappears after the cited lines are read", () => {
  const locators = new CodeLocatorRegistry();
  locators.register(
    "`onShowFileSelector` is implemented in `entry/src/main/ets/Page.ets:163`.",
  );
  assert.match(
    locators.hint("search onShowFileSelector") ?? "",
    /Page\.ets:163/,
  );
  locators.markRead("entry/src/main/ets/Page.ets", 160, 170);
  assert.equal(locators.hint("search onShowFileSelector"), null);
});

test("bounds consecutive reuse while leaving report submission exempt from the budget", async () => {
  const { ledger, budget } = setup();
  const tool = wrap(
    {
      execute: async () => ({
        matches: [
          { path: "src/First.ets", line: 10, content: "first observation" },
        ],
        next_cursor: null,
      }),
    },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await tool.execute!({ query: "same" }, {});
  for (let i = 0; i < 3; i += 1) await tool.execute!({ query: "same" }, {});
  await assert.rejects(tool.execute!({ query: "same" }, {}), /连续无进展/);
  assert.equal(budget.cacheHits, 3);

  budget.attempts = 30;
  const submit = wrap(
    { execute: async () => ({ status: "submitted" }) },
    "agent",
    "submit_diagnosis_report",
    ledger,
    budget,
    true,
  );
  assert.deepEqual(await submit.execute!({}, {}), { status: "submitted" });
  assert.equal(budget.reportAttempts, 1);
});

test("canonical cache keys preserve nested order, array order, and undefined boundaries", async () => {
  const { ledger, budget } = setup();
  let calls = 0;
  const wrapped = wrap(
    {
      execute: async () => {
        calls += 1;
        return { value: calls };
      },
    },
    "mcp",
    "search_project_text",
    ledger,
    budget,
  );
  await wrapped.execute!({ nested: { b: 2, a: 1 }, list: [1, 2] }, {});
  await wrapped.execute!({ nested: { a: 1, b: 2 }, list: [1, 2] }, {});
  await wrapped.execute!({ nested: { a: 1, b: 2 }, list: [2, 1] }, {});
  await wrapped.execute!(
    { nested: { a: 1, b: 2 }, list: [1, 2], extra: undefined },
    {},
  );
  assert.equal(calls, 3);
  assert.equal(budget.cacheHits, 1);
});

test("does not cache non-read tools or reuse a cached observation after its evidence expires", async () => {
  const { ledger, budget } = setup();
  let writes = 0;
  const mutation = wrap(
    { execute: async () => ++writes },
    "mcp",
    "bind_repository",
    ledger,
    budget,
  );
  await mutation.execute!({}, {});
  await mutation.execute!({}, {});
  assert.equal(writes, 2);
  assert.equal(budget.cacheHits, 0);

  const observation = ledger.capture(
    "read_project_file",
    { relative_path: "a.ets" },
    {
      path: "a.ets",
      start_line: 1,
      content: "line",
    },
  ) as { evidence_refs: Array<{ id: string }> };
  const id = observation.evidence_refs[0]!.id;
  const signature = JSON.stringify([
    "mcp",
    "read_project_file",
    ["object", ["relative_path", ["string", "a.ets"]]],
  ]);
  budget.cache.set(signature, observation);
  ledger.entries.delete(id);
  let reads = 0;
  const read = wrap(
    {
      execute: async () => {
        reads += 1;
        return { path: "a.ets", start_line: 1, content: "line" };
      },
    },
    "mcp",
    "read_project_file",
    ledger,
    budget,
  );
  await read.execute!({ relative_path: "a.ets" }, {});
  assert.equal(reads, 1);
  assert.ok(ledger.entries.has(id));
});

test("limits report validation failures while allowing report attempts at the tool-call cap", async () => {
  const { ledger, budget } = setup();
  budget.attempts = 30;
  const submit = wrap(
    {
      execute: async () => {
        throw new Error("invalid citation");
      },
    },
    "agent",
    "submit_diagnosis_report",
    ledger,
    budget,
    true,
  );
  for (let i = 0; i < 3; i += 1)
    await assert.rejects(submit.execute!({}, {}), /invalid citation/);
  await assert.rejects(submit.execute!({}, {}), /提交尝试已达到/);
  assert.equal(budget.reportAttempts, 3);
  assert.equal(budget.failures, 3);
});
