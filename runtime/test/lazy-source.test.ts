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
  assert.equal(holder.bound(), false);
});

test('已绑定但会话缺少导航工具时返回 unavailable 并引导回退文本搜索', async () => {
  const holder = new LazySourceHolder(fakeProvider([]), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  await holder.bind('/snapshots/abc');
  const result = await toolAt(toolset, 'search_code_symbols').execute({ query: 'Foo' }) as { status: string; limitation: string };
  assert.equal(result.status, 'unavailable');
  assert.match(result.limitation, /search_project_text/);
});

test('双槽位：compare 绑定独立路由，事故端不受影响', async () => {
  const log: string[] = [];
  const holder = new LazySourceHolder(fakeProvider(log), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  await holder.bind('/snapshots/harmony', 'incident');
  assert.equal(holder.bound('incident'), true);
  assert.equal(holder.bound('compare'), false);

  // compare 未绑定时返回对照端专属提示
  const unbound = await toolAt(toolset, 'read_project_file').execute({ relative_path: 'a', target: 'compare' }) as { status: string; limitation: string };
  assert.equal(unbound.status, 'unbound');
  assert.match(unbound.limitation, /对照端/);

  await holder.bind('/snapshots/ios', 'compare');
  assert.deepEqual(log, ['bind:/snapshots/harmony', 'bind:/snapshots/ios']);

  // 两侧各自可用；事故端默认路由
  const incident = await toolAt(toolset, 'read_project_file').execute({ relative_path: 'src/a.ets' });
  const compare = await toolAt(toolset, 'read_project_file').execute({ relative_path: 'src/a.ets', target: 'compare' });
  assert.deepEqual(incident, compare); // fake 两侧同返回，但各自命中对应槽位会话
});

test('target 是路由参数：下发给真实工具前被剥离', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const holder = new LazySourceHolder(fakeProvider([], {
    search_project_text: {
      execute: async (args) => {
        seen.push(args);
        return { matches: [] };
      },
    },
  }), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  await holder.bind('/snapshots/ios', 'compare');
  await toolAt(toolset, 'search_project_text').execute({ query: 'kuabao', target: 'compare', limit: 5 });
  assert.deepEqual(seen, [{ query: 'kuabao', limit: 5 }]);
});

test('compare 换绑只关对照端旧会话；close 同时关两侧', async () => {
  const log: string[] = [];
  const holder = new LazySourceHolder(fakeProvider(log), 'conv-1');
  await holder.bind('/snapshots/harmony', 'incident');
  await holder.bind('/snapshots/ios-old', 'compare');
  await holder.bind('/snapshots/ios-new', 'compare');
  assert.deepEqual(log, [
    'bind:/snapshots/harmony',
    'bind:/snapshots/ios-old',
    'disconnect:/snapshots/ios-old',
    'bind:/snapshots/ios-new',
  ]);
  await holder.close();
  assert.deepEqual(log.slice(4).sort(), ['disconnect:/snapshots/harmony', 'disconnect:/snapshots/ios-new']);
  assert.equal(holder.bound('incident'), false);
  assert.equal(holder.bound('compare'), false);
});

test('parse_hilog 不支持 target 路由（只面向事故端粘贴日志）', async () => {
  const holder = new LazySourceHolder(fakeProvider([]), 'conv-1');
  const toolset = createLazySourceToolset(holder);
  // 事故端未绑定、compare 已绑定：parse_hilog 仍只看事故端
  await holder.bind('/snapshots/ios', 'compare');
  const result = await toolAt(toolset, 'parse_hilog').execute({ log_text: 'ERROR ...' }) as { status: string };
  assert.equal(result.status, 'unbound');
});
