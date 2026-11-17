import assert from 'node:assert/strict';
import test from 'node:test';

import { createLazySourceToolset, LazySourceHolder } from '../src/capabilities/lazy-source.js';

type FakeTool = { execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown> };

function fakeProvider(log: string[], tools: Record<string, FakeTool> = {}) {
  return {
    async createRepositorySession(_conversationId: string, snapshotPath: string) {
      log.push(`bind:${snapshotPath}`);
      return {
        client: { async disconnect() { log.push(`disconnect:${snapshotPath}`); } },
        toolsets: {
          repository: {
            read_project_file: { execute: async () => ({ path: 'src/a.ets', start_line: 1, end_line: 3, content: 'real' }) },
            search_project_text: { execute: async () => ({ matches: [], truncated: false }) },
            ...tools,
          },
        },
      } as never;
    },
  };
}

function toolAt(toolset: ReturnType<typeof createLazySourceToolset>, name: string) {
  return (toolset.repository as Record<string, { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> }>)[name]!;
}

test('未绑定时代理工具返回 unbound 软提示而不是抛错', async () => {
  const holder = new LazySourceHolder(fakeProvider([]), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  const result = await toolAt(toolset, 'read_project_file').execute({ relative_path: 'src/a.ets' });
  assert.deepEqual(result, {
    status: 'unbound',
    limitation: (result as { limitation: string }).limitation,
  });
  assert.match((result as { limitation: string }).limitation, /prepare_source/);
});

test('parse_hilog 未绑定时的提示引导直接阅读粘贴日志', async () => {
  const holder = new LazySourceHolder(fakeProvider([]), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  const result = await toolAt(toolset, 'parse_hilog').execute({ log_text: 'ERROR ...' }) as { limitation: string };
  assert.match(result.limitation, /直接阅读/);
});

test('bind 后轮内立即可用：代理转发到真实会话工具', async () => {
  const log: string[] = [];
  const holder = new LazySourceHolder(fakeProvider(log), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  await holder.bind('/snapshots/abc');
  const result = await toolAt(toolset, 'read_project_file').execute({ relative_path: 'src/a.ets' });
  assert.deepEqual(log, ['bind:/snapshots/abc']);
  assert.deepEqual(result, { path: 'src/a.ets', start_line: 1, end_line: 3, content: 'real' });
});

test('rebind 关闭旧会话再开新会话；close 幂等', async () => {
  const log: string[] = [];
  const holder = new LazySourceHolder(fakeProvider(log), 'conv-1');
  await holder.bind('/snapshots/old');
  await holder.bind('/snapshots/new');
  assert.deepEqual(log, ['bind:/snapshots/old', 'disconnect:/snapshots/old', 'bind:/snapshots/new']);
  await holder.close();
  await holder.close();
  assert.deepEqual(log.slice(3), ['disconnect:/snapshots/new']);
  assert.equal(holder.bound, false);
});

test('已绑定但会话缺少导航工具时返回 unavailable 并引导回退文本搜索', async () => {
  const holder = new LazySourceHolder(fakeProvider([]), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  await holder.bind('/snapshots/abc');
  const result = await toolAt(toolset, 'search_code_symbols').execute({ query: 'Foo' }) as { status: string; limitation: string };
  assert.equal(result.status, 'unavailable');
  assert.match(result.limitation, /search_project_text/);
});
