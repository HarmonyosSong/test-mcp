import assert from 'node:assert/strict';
import test from 'node:test';

import { projectLogResult } from '../src/diagnosis/log-projection.js';
import { ObservationRegistry } from '../src/diagnosis/observations.js';
import { RoundGuard } from '../src/diagnosis/round-guard.js';

const STACK_A = 'at doTrade (pay.js:12:34) -> at async pay (index.js:88:21)\nat onError (pay.js:40:10)';
const STACK_B = 'at fetch (net.js:5:1)';

function fixture() {
  return {
    logcenter: {
      scanned_services: 12,
      matched_services: 1,
      elapsed_ms: 812,
      results: [
        {
          service: 'pay-trade',
          total: 3,
          pagination: { next_cursor: 'cursor-abc-123', has_more: true },
          warnings: ['日志中心限流，覆盖不全'],
          remark: null,
          logs: [
            {
              ts: '2026-11-19 10:01:02.111', level: 'ERROR', clickid: 'doTrade',
              msg: '支付过程中出现问题 code=500', traceId: 'aaaa1111bbbb2222',
              uid: '2592373', cardId: '165010784572', deviceId: 'TAL2606ABC',
              osVersion: 'OpenHarmony-7.0.0.111', appVersion: '7.106.0',
              stack: STACK_A, durationMs: '2046', nested: { retry: 2, flag: true },
            },
            {
              ts: '2026-11-19 10:01:10.222', level: 'WARN', clickid: 'doTrade',
              msg: '支付过程中出现问题 code=502', traceId: 'cccc3333dddd4444',
              uid: '2592373', cardId: '165010784572', deviceId: 'TAL2606ABC',
              osVersion: 'OpenHarmony-7.0.0.111', appVersion: '7.106.0',
              stack: STACK_A, durationMs: '1987', nested: { retry: 3, flag: false },
            },
            {
              ts: '2026-11-19 10:02:18.333', level: 'ERROR', clickid: 'payResult',
              msg: '收银台提示 | 含竖线', traceId: 'eeee5555ffff6666',
              uid: '2592373', cardId: '165010784572', deviceId: 'TAL2606ABC',
              osVersion: 'OpenHarmony-7.0.0.111', appVersion: '7.106.0',
              stack: STACK_B, durationMs: '88', nested: { retry: 0, flag: true },
            },
          ],
        },
      ],
    },
    cloud: {
      scanned_topics: 3,
      matched_topics: 1,
      results: [
        {
          source: 'cloud', topic: 'prod-android', total: 0, progress: 'Complete',
          time: '2026-11-19 00:00:00 to 2026-11-19 23:59:59', logs: [],
        },
      ],
    },
    partial_failures: [],
    truncated: { services_skipped: 1, topics_skipped: 0 },
  };
}

function restoreCells(text: string): string {
  return text.replaceAll('⏎', '\n').replaceAll('\\|', '|');
}

test('投影对聚合日志结果：逐字段保真、行数守恒、stack 引用完整', () => {
  const source = fixture();
  const projected = projectLogResult(source);
  assert.equal(typeof projected, 'string');
  const text = projected as string;
  const restored = restoreCells(text);

  // 每个记录行的每个字段值都必须原样可找回（嵌套值按 JSON 内联找回）。
  const groups = [...source.logcenter.results, ...source.cloud.results];
  let fieldCount = 0;
  for (const group of groups) {
    for (const row of group.logs as Record<string, unknown>[]) {
      for (const [key, value] of Object.entries(row)) {
        fieldCount += 1;
        const expect = typeof value === 'object' ? JSON.stringify(value) : String(value);
        assert.ok(restored.includes(expect), `字段 ${key} 的值未找回: ${expect.slice(0, 60)}`);
      }
    }
  }
  assert.ok(fieldCount > 0);

  // 行数守恒：3 条记录行 + 表头/分隔行不计。
  const dataRows = (text.match(/^\| 2026-/gm) ?? []).length;
  assert.equal(dataRows, 3);

  // stack 引用：S 编号都有定义，且重复原文只保留一份。
  const refs = [...text.matchAll(/\| (S\d+) \|$/gm)].map((m) => m[1]);
  const defs = [...text.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]);
  assert.ok(refs.length > 0 && defs.length > 0);
  for (const ref of refs) assert.ok(defs.includes(ref), `悬空 stack 引用 ${ref}`);
  assert.equal(restored.split(STACK_A).length - 1, 1, '重复 stack 原文只保留一份');
  assert.ok(restored.includes(STACK_B));
});

test('恒等字段提升到公共块；诊断关键列永远保留为列', () => {
  const text = projectLogResult(fixture()) as string;
  assert.match(text, /公共：.*uid=2592373/);
  assert.match(text, /公共：.*deviceId=TAL2606ABC/);
  const header = text.split('\n').find((line) => line.startsWith('| ') && line.includes('---') === false) ?? '';
  for (const column of ['ts', 'level', 'clickid', 'msg', 'traceId']) {
    assert.ok(header.includes(`| ${column} |`) || header.startsWith(`| ${column} `), `关键列缺失: ${column}`);
  }
  assert.ok(!header.includes('| uid |'), '恒等字段不应再占列');
});

test('空 logs 数组渲染为空组，不抛错', () => {
  const text = projectLogResult(fixture()) as string;
  assert.match(text, /prod-android（0 条）/);
  assert.match(text, /（无日志）/);
});

test('无 logs 结构的结果原样返回，不做转换', () => {
  const plain = { status: 'ok', learner: { uid: '2592373' } };
  assert.equal(projectLogResult(plain), plain);
  assert.equal(projectLogResult('raw string'), 'raw string');
  assert.equal(projectLogResult(null), null);
});

test('竖线与换行转义不破坏表格且可还原', () => {
  const text = projectLogResult(fixture()) as string;
  assert.ok(text.includes('收银台提示 \\| 含竖线'), '竖线已转义');
  assert.ok(!text.split('\n').some((line) => line.startsWith('at doTrade')), 'stack 换行被压成可见符号');
  const restored = restoreCells(text);
  assert.ok(restored.includes('收银台提示 | 含竖线'));
});

test('嵌套兄弟字段与 null、空数组都不丢失（翻页游标可续取）', () => {
  const text = projectLogResult(fixture()) as string;
  assert.ok(text.includes('cursor-abc-123'), 'pagination.next_cursor 必须保留');
  assert.ok(text.includes('has_more'), 'pagination.has_more 必须保留');
  assert.ok(text.includes('日志中心限流，覆盖不全'), 'warnings 内容必须保留');
  assert.ok(text.includes('remark=null'), 'null 字段必须显式保留');
  assert.ok(text.includes('- partial_failures: []'), '空数组必须保留字段存在性');
});

test('标题已消费的键不进 meta 重复输出；同组其余标题类键仍保留', () => {
  const result = {
    groups: [
      {
        service: 'pay-trade',
        topic: 'trade-pay',
        total: 2,
        logs: [
          { ts: '2026-11-20 10:00:01', msg: 'a' },
          { ts: '2026-11-20 10:00:02', msg: 'b' },
        ],
      },
    ],
  };
  const text = projectLogResult(result) as string;
  const titleLine = text.split('\n').find((line) => line.startsWith('## pay-trade')) ?? '';
  assert.ok(titleLine, '标题行存在');
  assert.ok(!titleLine.includes('service=pay-trade'), '标题已含 service，meta 不得重复');
  assert.ok(titleLine.includes('topic=trade-pay'), '标题未消费的 topic 仍须进 meta（零丢弃）');
  assert.ok(titleLine.includes('total=2'), '其他标量照常进 meta');
});

test('单条命中：字段全恒定时不渲染畸形空表格，关键字段值仍在公共块', () => {
  const single = {
    source: 'cloud', topic: 'prod-android', total: 1,
    logs: [
      { ts: '2026-11-19 10:00:00.000', level: 'ERROR', clickid: 'doTrade', msg: '支付失败 code=2', traceId: 'ff00ff00' },
    ],
  };
  const text = projectLogResult(single) as string;
  assert.ok(!/^\|\s*\|\s*$/m.test(text), '不得出现空表头');
  assert.ok(!/^\|(---\|)+$/m.test(text) || /\| [a-zA-Z]/.test(text), '不得有孤立分隔行');
  assert.match(text, /公共：.*traceId=ff00ff00/);
  assert.match(text, /公共：.*level=ERROR/);
  assert.match(text, /（全部字段恒定，每行内容同上「公共」块）/);
  assert.match(text, /prod-android（1 条）/);
});

test('guard 集成：log 命名空间结果投影为 Markdown，其它命名空间原样', async () => {
  const guard = new RoundGuard({ observations: new ObservationRegistry() });
  const logTool = guard.wrap(
    { execute: async (_args: Record<string, unknown>, _context?: unknown) => fixture() },
    'log',
    'search_both_logs',
  );
  const presented = await logTool.execute({ query: '2592373' }, undefined);
  assert.equal(typeof presented, 'string');
  assert.match(presented as unknown as string, /^# 日志检索结果（投影/);

  const otherTool = guard.wrap(
    { execute: async (_args: Record<string, unknown>, _context?: unknown) => ({ status: 'ok', hits: [{ name: 'x' }] }) },
    'knowledge',
    'search_knowledge',
  );
  const untouched = await otherTool.execute({ query: 'x' }, undefined);
  assert.ok(untouched && typeof untouched === 'object' && 'status' in (untouched as Record<string, unknown>));
});
