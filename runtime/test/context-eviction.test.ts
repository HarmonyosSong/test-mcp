import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { ProcessInputStepArgs } from '@mastra/core/processors';

import {
  EvidenceOffloadStore,
  ToolResultEvictor,
  type SummarizeFn,
} from '../src/diagnosis/context-eviction.js';

function userMessage(text: string): MastraDBMessage {
  return { role: 'user', content: { parts: [{ type: 'text', text }] } } as unknown as MastraDBMessage;
}

/** 自包含的工具调用消息：调用与结果在同一 part（MastraDBMessage 状态原地迁移）。 */
function toolResultMessage(toolCallId: string, toolName: string, result: unknown): MastraDBMessage {
  return {
    role: 'assistant',
    content: {
      parts: [{
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId,
          toolName,
          args: { query: toolCallId },
          state: 'result',
          result,
        },
      }],
    },
  } as unknown as MastraDBMessage;
}

function resultOf(message: MastraDBMessage): unknown {
  const part = message.content.parts[0] as { toolInvocation?: { result?: unknown } };
  return part.toolInvocation?.result;
}

function argsOf(messages: MastraDBMessage[], steps?: unknown[]): ProcessInputStepArgs {
  return { messages, steps: steps ?? [] } as unknown as ProcessInputStepArgs;
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'eviction-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASE = {
  conversationId: 'conv',
  targetTokens: 45_000,
  keepRecentResults: 1,
  minEvictChars: 1_000,
  clampChars: 800,
};

test('低于预算时不动作、消息保持原样', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 100_000,
    });
    const messages = [userMessage('问题'), toolResultMessage('call-a', 'query', 'x'.repeat(5_000))];
    const result = await evictor.processInputStep(argsOf(messages));
    assert.equal(result, undefined);
    assert.equal(resultOf(messages[1]!), 'x'.repeat(5_000));
    assert.equal(evictor.stats.evicted, 0);
  });
});

test('白名单：状态工具的大结果永不驱逐', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 100, keepRecentResults: 0,
    });
    const stateResult = 's'.repeat(20_000);
    const messages = [
      userMessage('问题'),
      toolResultMessage('call-p', 'prepare_source', stateResult),
      toolResultMessage('call-l', 'lookup_learner', stateResult),
      toolResultMessage('call-s', 'load_skill', stateResult),
      toolResultMessage('call-c', 'consult_compass', stateResult),
      toolResultMessage('call-r', 'read_evidence', stateResult),
    ];
    await evictor.processInputStep(argsOf(messages));
    for (const message of messages.slice(1)) {
      assert.equal(resultOf(message), stateResult, '状态工具结果必须原样保留');
    }
    assert.equal(evictor.stats.evicted, 0);
    assert.equal(evictor.stats.ephemeralCleared, 0);
  });
});

test('发现类结果清为占位符且不落盘（可用原调用重查）', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 100, keepRecentResults: 0,
    });
    const messages = [
      userMessage('问题'),
      toolResultMessage('call-a', 'list_services', 'x'.repeat(10_000)),
      toolResultMessage('call-b', 'cloud_topics', 'y'.repeat(10_000)),
    ];
    const outcome = await evictor.processInputStep(argsOf(messages));
    assert.ok(outcome && 'messages' in outcome);
    assert.match(String(resultOf(messages[1]!)), /^\[已清理：过期的发现类结果\] list_services\(/);
    assert.match(String(resultOf(messages[2]!)), /^\[已清理：过期的发现类结果\] cloud_topics\(/);
    assert.equal(evictor.stats.ephemeralCleared, 2);
    assert.equal(evictor.stats.evicted, 0);
    // 不落盘：readSlice 取回的是缺文件错误。
    const missing = await evictor.offloadStore.readSlice('call-a', 0, 100);
    assert.equal(missing.error, true);
  });
});

test('证据钳制：保头尾、中间省略标记、ev-ID 保留，原文完整外置', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 100, keepRecentResults: 0, clampChars: 1_000,
    });
    const original = 'H'.repeat(4_000) + 'M'.repeat(4_000) + 'T'.repeat(2_000);
    const withRefs = { evidence_refs: [{ id: 'ev-abc123' }, 'ev-def456'], payload: original };
    const messages = [userMessage('问题'), toolResultMessage('call-a', 'read_project_file', withRefs)];
    await evictor.processInputStep(argsOf(messages));

    const clamped = String(resultOf(messages[1]!));
    assert.match(clamped, /^\[ev-file:call-a\] read_project_file\(/, '钳制结果以指针头开头');
    assert.match(clamped, /ev-abc123、ev-def456/, '已登记的 ev-ID 随指针保留');
    assert.match(clamped, /--- 开头 ---/);
    assert.match(clamped, /…\[中间省略 \d+ 字符\]…/);
    assert.match(clamped, /--- 结尾 ---/);
    assert.ok(clamped.includes('H'.repeat(200)), '开头摘录保留');
    assert.ok(!clamped.includes('M'.repeat(2_000)), '中间内容被省略');
    assert.ok(clamped.includes('T'.repeat(300)), '结尾摘录保留（错误堆栈在尾部）');
    assert.equal(evictor.stats.evicted, 1);
    assert.equal(evictor.stats.evictedChars, JSON.stringify(withRefs).length);

    // 外置文件完整可读。
    const full = JSON.stringify(withRefs);
    const slice = await evictor.offloadStore.readSlice('call-a', 0, 4_100);
    assert.equal(slice.total_chars, full.length);
    assert.equal(slice.content, full.slice(0, 4_100));
    assert.equal(slice.has_more, true);
  });
});

test('最近 N 条结果保持原样，小结果不处理', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 100, keepRecentResults: 2,
    });
    const messages = [
      userMessage('问题'),
      toolResultMessage('call-a', 'query', 'a'.repeat(5_000)),
      toolResultMessage('call-b', 'list_services', 'b'.repeat(5_000)),
      toolResultMessage('call-c', 'query', 'small'),
      toolResultMessage('call-d', 'query', 'd'.repeat(6_000)),
      toolResultMessage('call-e', 'query', 'e'.repeat(7_000)),
    ];
    await evictor.processInputStep(argsOf(messages));
    // 大结果候选 a/b/d/e，保留最近 2 条（d/e），处理 a/b。
    assert.match(String(resultOf(messages[1]!)), /^\[ev-file:call-a\]/);
    assert.match(String(resultOf(messages[2]!)), /^\[已清理：过期的发现类结果\]/);
    assert.equal(resultOf(messages[3]!), 'small', '小结果原样保留');
    assert.equal(resultOf(messages[4]!), 'd'.repeat(6_000), '最近结果原样保留');
    assert.equal(resultOf(messages[5]!), 'e'.repeat(7_000));
  });
});

test('幂等：占位符与钳制结果不会被重复处理', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 100, keepRecentResults: 0,
    });
    const messages = [
      toolResultMessage('call-a', 'query', 'x'.repeat(5_000)),
      toolResultMessage('call-b', 'list_services', 'y'.repeat(5_000)),
    ];
    await evictor.processInputStep(argsOf(messages));
    const second = await evictor.processInputStep(argsOf(messages));
    assert.equal(second, undefined, '第二轮无新候选');
    assert.equal(evictor.stats.evicted, 1);
    assert.equal(evictor.stats.ephemeralCleared, 1);
    assert.equal(evictor.stats.passes, 1);
  });
});

test('usage 锚定：锚点值优先于离线字节估算', async () => {
  await withStore(async (dir) => {
    // 消息很小（离线估算远低于预算），但锚点 usage 很大 → 必须触发。
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 8_000, keepRecentResults: 0, minEvictChars: 100,
    });
    const small = [userMessage('问题')];
    await evictor.processInputStep(argsOf(small)); // 第一次调用：记录 prevBytes
    const messages = [userMessage('问题'), toolResultMessage('call-a', 'query', 'q'.repeat(200))];
    const outcome = await evictor.processInputStep(
      argsOf(messages, [{ usage: { inputTokens: 50_000 } }]),
    );
    assert.ok(outcome && 'messages' in outcome, '锚点 50K 远超预算，必须触发压缩');
    assert.match(String(resultOf(messages[1]!)), /^\[ev-file:call-a\]/);
  });
});

test('usage 锚定：压缩后差值变负，估算随之回落', async () => {
  await withStore(async (dir) => {
    const evictor = new ToolResultEvictor({
      ...BASE, offloadDir: dir, budgetTokens: 8_000, keepRecentResults: 0, minEvictChars: 100,
    });
    await evictor.processInputStep(argsOf([userMessage('问题')]));
    const messages = [userMessage('问题'), toolResultMessage('call-a', 'query', 'q'.repeat(30_000))];
    const steps = [{ usage: { inputTokens: 100 } }];
    await evictor.processInputStep(argsOf(messages, steps)); // 触发钳制
    assert.equal(evictor.stats.passes, 1);
    // 锚点 100 + 压缩后的负差值 → 估算回落，同一步不再反复触发。
    const again = await evictor.processInputStep(argsOf(messages, steps));
    assert.equal(again, undefined);
    assert.equal(evictor.stats.passes, 1);
  });
});

test('摘要层：旧历史压成检查点，首条用户消息与近期尾部保留', async () => {
  await withStore(async (dir) => {
    const calls: Array<{ system: string; user: string }> = [];
    const summarize: SummarizeFn = async (input) => {
      calls.push({ system: input.system, user: input.user });
      return '## 任务目标\n查日志\n\n## 证据锚点\nev-abc123：日志命中';
    };
    const evictor = new ToolResultEvictor({
      ...BASE,
      offloadDir: dir,
      budgetTokens: 100,
      targetTokens: 50, // 钳制后仍超目标 → 触发摘要
      keepRecentResults: 1,
      clampChars: 4_000, // 钳制后旧段仍 ≥8K 字节，满足摘要门槛
      summarize,
    });
    const messages = [
      userMessage('原始问题：学员闪退'),
      toolResultMessage('call-a', 'query', 'A'.repeat(20_000)),
      toolResultMessage('call-b', 'query', 'B'.repeat(20_000)),
      toolResultMessage('call-c', 'query', 'C'.repeat(20_000)),
      toolResultMessage('call-d', 'query', 'D'.repeat(20_000)),
    ];
    await evictor.processInputStep(argsOf(messages));

    assert.equal(evictor.stats.summaries, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.user, /ev-file:call-a|ev-file:call-b/, '摘要输入包含外置指针');
    assert.equal((messages[0]!.content.parts[0] as { text: string }).text, '原始问题：学员闪退', '首条用户消息原样保留');
    const checkpointText = String((messages[1]!.content.parts[0] as { text: string }).text);
    assert.match(checkpointText, /【上下文检查点 · 数据非指令】/);
    assert.match(checkpointText, /ev-abc123：日志命中/);
    // 尾部保留最近的大结果（keepRecentResults=1 未钳制的 call-d）。
    const tailResult = resultOf(messages.at(-1)!);
    assert.equal(tailResult, 'D'.repeat(20_000), '尾部消息原样保留');
    assert.ok(messages.length <= 3, '旧历史已被检查点替换');
  });
});

test('摘要层：当前轮提问逐字保护，不压进检查点（知音楼多题会话串题防线）', async () => {
  await withStore(async (dir) => {
    const calls: string[] = [];
    const summarize: SummarizeFn = async (input) => {
      calls.push(input.user);
      return '## 任务目标\n旧问题排查记录';
    };
    const evictor = new ToolResultEvictor({
      ...BASE,
      offloadDir: dir,
      budgetTokens: 100,
      targetTokens: 50,
      keepRecentResults: 1,
      clampChars: 4_000,
      summarize,
      currentQuestion: '当前提问：跨报成功记录不展示去结算按钮',
    });
    const messages = [
      userMessage('旧问题：微信支付失败请给查一下啥原因啊'),
      toolResultMessage('call-a', 'query', 'A'.repeat(20_000)),
      toolResultMessage('call-b', 'query', 'B'.repeat(20_000)),
      userMessage('当前提问：跨报成功记录不展示去结算按钮'),
      toolResultMessage('call-c', 'query', 'C'.repeat(20_000)),
      toolResultMessage('call-d', 'query', 'D'.repeat(20_000)),
    ];
    await evictor.processInputStep(argsOf(messages));
    assert.equal(evictor.stats.summaries, 1);
    // 压缩后结构：[首条锚点][检查点][当前提问（原样）][近期尾部]。
    const texts = messages.map((message) =>
      message.role === 'user' ? String((message.content.parts[0] as { text?: string }).text ?? '') : '');
    assert.equal(texts[0], '旧问题：微信支付失败请给查一下啥原因啊', '首条锚点不变');
    assert.match(texts[1]!, /【上下文检查点/);
    const questionAt = texts.findIndex((text) => text === '当前提问：跨报成功记录不展示去结算按钮');
    assert.ok(questionAt > 1, '当前提问须在锚点与检查点之后');
    assert.ok(questionAt < messages.length - 1, '当前提问须保留在近期步骤之前');
    // 当前提问不是被摘要复述，而是作为活消息逐字保留——摘要输入里没有它。
    assert.ok(!calls[0]!.includes('跨报成功记录不展示去结算按钮'), '当前提问不得进入检查点摘要');
  });
});

test('摘要层：重复同文提问时保护最后一次出现（历史同文消息照常压缩）', async () => {
  await withStore(async (dir) => {
    const summarize: SummarizeFn = async () => '检查点';
    const evictor = new ToolResultEvictor({
      ...BASE,
      offloadDir: dir,
      budgetTokens: 100,
      targetTokens: 50,
      keepRecentResults: 1,
      clampChars: 4_000,
      summarize,
      currentQuestion: '重复的问题',
    });
    const messages = [
      userMessage('重复的问题'), // 首条锚点（同文）
      toolResultMessage('call-a', 'query', 'A'.repeat(20_000)),
      userMessage('重复的问题'), // 历史同文消息——应被压缩掉
      toolResultMessage('call-b', 'query', 'B'.repeat(20_000)),
      userMessage('重复的问题'), // 当前提问（最后一次出现）——受保护
      toolResultMessage('call-c', 'query', 'C'.repeat(20_000)),
    ];
    await evictor.processInputStep(argsOf(messages));
    assert.equal(evictor.stats.summaries, 1);
    const survivors = messages.filter((message) =>
      message.role === 'user'
      && String((message.content.parts[0] as { text?: string }).text ?? '') === '重复的问题');
    // 锚点 + 受保护的当前提问共两条；中间那条同文历史已被检查点取代。
    assert.equal(survivors.length, 2);
    assert.ok(messages.indexOf(survivors[1]!) > 1, '受保护的当前提问在检查点之后');
  });
});

test('摘要层增量更新：旧检查点并入新检查点，不叠加', async () => {
  await withStore(async (dir) => {
    const seen: string[] = [];
    let round = 0;
    const summarize: SummarizeFn = async (input) => {
      seen.push(input.user);
      round += 1;
      return `检查点v${round}`;
    };
    const evictor = new ToolResultEvictor({
      ...BASE,
      offloadDir: dir,
      budgetTokens: 100,
      targetTokens: 50,
      keepRecentResults: 1,
      clampChars: 4_000,
      summarize,
    });
    const messages = [
      userMessage('问题'),
      toolResultMessage('call-a', 'query', 'A'.repeat(20_000)),
      toolResultMessage('call-b', 'query', 'B'.repeat(20_000)),
      toolResultMessage('call-c', 'query', 'C'.repeat(20_000)),
    ];
    await evictor.processInputStep(argsOf(messages));
    assert.equal(evictor.stats.summaries, 1);
    // 第二轮：尾部追加新的大结果，再触发摘要。
    messages.push(toolResultMessage('call-d', 'query', 'D'.repeat(20_000)));
    messages.push(toolResultMessage('call-e', 'query', 'E'.repeat(20_000)));
    await evictor.processInputStep(argsOf(messages));
    assert.equal(evictor.stats.summaries, 2);
    assert.match(seen[1]!, /检查点v1/, '第二次摘要须携带旧检查点做增量更新');
    // 检查点消息仍只有一条（更新而非叠加）。
    const checkpoints = messages.filter((message) =>
      message.role === 'user'
      && String((message.content.parts[0] as { text?: string }).text ?? '').startsWith('【上下文检查点'));
    assert.equal(checkpoints.length, 1);
    assert.match(String((checkpoints[0]!.content.parts[0] as { text: string }).text), /检查点v2/);
  });
});

test('摘要按 step 切割：一步内的 reasoning 与全部调用同进同退（DeepSeek 交错思考约束）', async () => {
  await withStore(async (dir) => {
    const summarize: SummarizeFn = async () => '检查点';
    const evictor = new ToolResultEvictor({
      ...BASE,
      offloadDir: dir,
      budgetTokens: 100,
      targetTokens: 50,
      minEvictChars: 1_000_000, // 禁止钳制，隔离摘要行为
      summarize,
    });
    const invocationPart = (id: string, fill: string) => ({
      type: 'tool-invocation',
      toolInvocation: { toolCallId: id, toolName: 'query', args: {}, state: 'result', result: fill.repeat(12_000) },
    });
    const reasoningPart = (text: string) => ({ type: 'reasoning', text });
    const stepStart = { type: 'step-start' };
    // 真实结构：一步 = reasoning + 多个并行调用，step-start 标记新一步。
    const assistant = {
      role: 'assistant',
      content: {
        parts: [
          reasoningPart('r-1'), invocationPart('call-a', 'A'), invocationPart('call-a2', 'a'),
          stepStart,
          reasoningPart('r-2'), invocationPart('call-b', 'B'), invocationPart('call-b2', 'b'),
          { ...stepStart },
          reasoningPart('r-3'), invocationPart('call-c', 'C'),
        ],
      },
    } as unknown as MastraDBMessage;
    const messages = [userMessage('问题'), assistant];
    await evictor.processInputStep(argsOf(messages));
    assert.equal(evictor.stats.summaries, 1);
    // 存活的最近一步必须完整：step-start + reasoning + 该步全部调用。
    const keptParts = (messages.at(-1)! as unknown as {
      content: { parts: Array<{ type: string; text?: string; toolInvocation?: { toolCallId: string } }> },
    }).content.parts;
    assert.deepEqual(keptParts.map((part) => part.type), ['step-start', 'reasoning', 'tool-invocation']);
    assert.equal(keptParts[1]!.text, 'r-3', '尾部步骤的 reasoning 必须成对保留');
    // 旧步骤整步进入检查点（含其 reasoning 与全部调用），消息里不再有残留。
    const allText = JSON.stringify(messages);
    for (const stale of ['r-1', 'r-2', 'call-a', 'call-a2', 'call-b', 'call-b2']) {
      assert.ok(!allText.includes(stale), `${stale} 应已随整步移除`);
    }
    assert.match(String((messages[1]!.content.parts[0] as { text: string }).text), /【上下文检查点/);
  });
});

test('摘要失败降级：本轮不再尝试，消息保持清理+钳制结果', async () => {
  await withStore(async (dir) => {
    const summarize: SummarizeFn = async () => {
      throw new Error('model unavailable');
    };
    const evictor = new ToolResultEvictor({
      ...BASE,
      offloadDir: dir,
      budgetTokens: 100,
      targetTokens: 50,
      keepRecentResults: 0,
      clampChars: 4_000,
      summarize,
    });
    const messages = [
      userMessage('问题'),
      toolResultMessage('call-a', 'query', 'A'.repeat(20_000)),
      toolResultMessage('call-b', 'query', 'B'.repeat(20_000)),
      toolResultMessage('call-c', 'query', 'C'.repeat(20_000)),
    ];
    const outcome = await evictor.processInputStep(argsOf(messages));
    assert.ok(outcome && 'messages' in outcome, '摘要失败不影响清理+钳制生效');
    assert.equal(evictor.stats.summaries, 0);
    assert.match(String(resultOf(messages[1]!)), /^\[ev-file:call-a\]/);
    // 降级后不再调用摘要。
    messages.push(toolResultMessage('call-c', 'query', 'C'.repeat(20_000)));
    await evictor.processInputStep(argsOf(messages));
    assert.equal(evictor.stats.summaries, 0);
  });
});

test('readSlice 分页与越界、缺文件语义', async () => {
  await withStore(async (dir) => {
    const store = new EvidenceOffloadStore(dir);
    await store.put('file-1', {
      tool: 'query', args_summary: '{}', result_chars: 10, result_text: '0123456789', stored_at: 'now',
    });
    const head = await store.readSlice('file-1', 0, 4);
    assert.deepEqual(
      { content: head.content, has_more: head.has_more, offset: head.offset },
      { content: '0123', has_more: true, offset: 0 },
    );
    const tail = await store.readSlice('file-1', 8, 4);
    assert.deepEqual(
      { content: tail.content, has_more: tail.has_more, returned: tail.returned_chars },
      { content: '89', has_more: false, returned: 2 },
    );
    const missing = await store.readSlice('not-exist', 0, 100);
    assert.equal(missing.error, true);
  });
});
