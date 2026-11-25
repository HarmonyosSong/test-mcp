import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeFollowupWithSource, synthesizeYachFollowupReply } from '../src/diagnosis/followup-analysis.js';
import { composeFollowupMessage, type CompassFollowupOutcome } from '../src/capabilities/consult-tool.js';
import { ConversationRecordSchema } from '../src/domain/schemas.js';

const timestamp = '2026-11-19T00:00:00.000Z';

function makeConversation() {
  return ConversationRecordSchema.parse({
    id: 'conv-analysis',
    title: 't',
    workspace_path: '/tmp/workspace',
    messages: [
      { id: 'msg-0', role: 'user', content: '支付过程中出现问题2', created_at: timestamp },
    ],
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function makeOutcome(overrides: Partial<CompassFollowupOutcome> = {}): CompassFollowupOutcome {
  return {
    state: 'completed',
    text: '下游 pay-trade 返回 status=2 orderInfo为空，根因是客户端请求体 orderInfo 传了空字符串。',
    taskId: 'task-1',
    contextId: 'ctx-1',
    truncated: false,
    limitations: [],
    durationMs: 1000,
    ...overrides,
  };
}

function makeInput(runRound: (prompt: string) => Promise<{ text: string; inputTokens: number | null; outputTokens: number | null } | null>) {
  return {
    // runRound 已注入，这两个字段不会被触达。
    modelConfiguration: null as never,
    capabilities: null as never,
    conversation: makeConversation(),
    outcome: makeOutcome(),
    runRound,
  };
}

test('协查为纯服务端原因：模型回哨兵词则不产出分析段', async () => {
  const result = await analyzeFollowupWithSource(
    makeInput(async () => ({ text: '无需客户端分析：orderInfo 由服务端模板渲染时丢失。', inputTokens: 10, outputTokens: 5 })),
  );
  assert.equal(result, null);
});

test('客户端侧原因：返回清洗后的分析正文与 token 用量', async () => {
  const result = await analyzeFollowupWithSource(
    makeInput(async (prompt) => {
      assert.match(prompt, /支付过程中出现问题2/);
      assert.match(prompt, /orderInfo 传了空字符串/);
      return {
        text: 'orderInfo 由收银台 XesAppCashierDeskViewController.ets:1293 拼接课程名生成；订单详情入口（OrderDetailPage.ets:318）赋值被注释，classInfoArray 恒为空。',
        inputTokens: 100,
        outputTokens: 50,
      };
    }),
  );
  assert.ok(result);
  assert.match(result.text, /XesAppCashierDeskViewController\.ets:1293/);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
});

test('模型违规带判定锚点时剥除该行', async () => {
  const result = await analyzeFollowupWithSource(
    makeInput(async () => ({ text: '判定：已定位\n正文：构造点在某文件。', inputTokens: null, outputTokens: null })),
  );
  assert.ok(result);
  assert.equal(result.text, '正文：构造点在某文件。');
});

test('分析轮抛错/空输出/未完成态一律回退 null，不影响协查转发', async () => {
  assert.equal(await analyzeFollowupWithSource(makeInput(async () => { throw new Error('model down'); })), null);
  assert.equal(await analyzeFollowupWithSource(makeInput(async () => ({ text: '   ', inputTokens: null, outputTokens: null }))), null);
  assert.equal(await analyzeFollowupWithSource(makeInput(async () => null)), null);

  const failed = makeInput(async () => {
    assert.fail('未完成态不应触发分析轮');
  });
  failed.outcome = makeOutcome({ state: 'failed', text: '', error: 'A2A timeout' });
  assert.equal(await analyzeFollowupWithSource(failed), null);
});

test('超长分析按上限截断', async () => {
  const result = await analyzeFollowupWithSource(
    makeInput(async () => ({ text: '长'.repeat(3_000), inputTokens: null, outputTokens: null })),
  );
  assert.ok(result);
  assert.ok(result.text.length <= 1_501);
  assert.ok(result.text.endsWith('…'));
});

// ———— onSkip 跳过原因：观测面板据此区分「为什么没分析」 ————

test('会话未绑定源码快照：不触发模型轮，onSkip 报告未绑定', async () => {
  const skips: string[] = [];
  const input = makeInput(async () => {
    assert.fail('未绑源码不应触发分析轮');
  });
  input.conversation = ConversationRecordSchema.parse({
    id: 'conv-nosource',
    title: 't',
    workspace_path: null,
    messages: [{ id: 'msg-0', role: 'user', content: '支付问题', created_at: timestamp }],
    created_at: timestamp,
    updated_at: timestamp,
  });
  const result = await analyzeFollowupWithSource({ ...input, onSkip: (reason) => skips.push(reason) });
  assert.equal(result, null);
  assert.deepEqual(skips, ['会话未绑定源码快照']);
});

test('onSkip 依次报告：纯服务端原因 / 无产出 / 异常 / 协查未完成', async () => {
  const skips: string[] = [];
  const onSkip = (reason: string) => skips.push(reason);

  await analyzeFollowupWithSource({
    ...makeInput(async () => ({ text: '无需客户端分析：纯服务端配置。', inputTokens: 1, outputTokens: 1 })),
    onSkip,
  });
  await analyzeFollowupWithSource({ ...makeInput(async () => null), onSkip });
  await analyzeFollowupWithSource({
    ...makeInput(async () => {
      throw new Error('model down');
    }),
    onSkip,
  });
  const failed = makeInput(async () => null);
  failed.outcome = makeOutcome({ state: 'failed', text: '', error: 'A2A timeout' });
  await analyzeFollowupWithSource({ ...failed, onSkip });

  assert.deepEqual(skips, [
    '模型判定纯服务端原因',
    '分析轮无产出（超时或空输出）',
    '分析轮异常：model down',
    '协查未完成或无结论文本',
  ]);
});

test('composeFollowupMessage 有分析时追加客户端侧段落', () => {
  const text = composeFollowupMessage(makeOutcome(), '构造点在某文件:1293。');
  assert.match(text, /【服务端协查结果】/);
  assert.match(text, /【客户端侧补充分析】\n构造点在某文件:1293。/);
  assert.match(text, /如有冲突以可观测证据为准/);

  const plain = composeFollowupMessage(makeOutcome());
  assert.ok(!plain.includes('客户端侧补充分析'));

  const failed = composeFollowupMessage(makeOutcome({ state: 'failed', text: '', error: 'A2A timeout' }), '不应出现');
  assert.ok(!failed.includes('客户端侧补充分析'));
  assert.match(failed, /协查超时或失败/);
});

// ———— synthesizeYachFollowupReply（知音楼模板 v2 综合终稿） ————

function makeYachConversation() {
  return ConversationRecordSchema.parse({
    id: 'conv-yach',
    title: 'IM群 · 张三',
    channel: 'yach_im',
    messages: [
      { id: 'msg-0', role: 'user', content: '支付过程中出现问题2', created_at: timestamp },
      { id: 'msg-1', role: 'assistant', content: '判定：可能定位（初步）\n**【给支持老师】**初步指向服务端……', created_at: timestamp },
    ],
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function synthesisInput(runRound: (prompt: string) => Promise<{ text: string; inputTokens: number | null; outputTokens: number | null } | null>) {
  return {
    modelConfiguration: null as never,
    conversation: makeYachConversation(),
    outcome: makeOutcome(),
    analysis: 'orderInfo 由收银台拼接课程名，订单详情入口漏赋值。',
    runRound,
  };
}

test('综合答复：材料齐装进入 prompt，合格模板 v2 文本原样返回', async () => {
  const result = await synthesizeYachFollowupReply(
    synthesisInput(async (prompt) => {
      assert.match(prompt, /支付过程中出现问题2/);
      assert.match(prompt, /初步指向服务端/);
      assert.match(prompt, /orderInfo 传了空字符串/);
      assert.match(prompt, /订单详情入口漏赋值/);
      return {
        text: '判定：已定位\n\n**【给支持老师】**该问题归属客户端，请同步客户端研发同学跟进。\n\n**【问题原因】**\n- 略',
        inputTokens: 500,
        outputTokens: 120,
      };
    }),
  );
  assert.ok(result);
  assert.match(result.text, /^判定：已定位/);
  assert.match(result.text, /【给支持老师】/);
  assert.equal(result.inputTokens, 500);
});

test('综合答复缺判定锚点/空输出/异常一律回退 null（走拼装文案）', async () => {
  assert.equal(await synthesizeYachFollowupReply(synthesisInput(async () => ({ text: '没有锚点的答复', inputTokens: null, outputTokens: null }))), null);
  assert.equal(await synthesizeYachFollowupReply(synthesisInput(async () => ({ text: '  ', inputTokens: null, outputTokens: null }))), null);
  assert.equal(await synthesizeYachFollowupReply(synthesisInput(async () => null)), null);
  assert.equal(await synthesizeYachFollowupReply(synthesisInput(async () => { throw new Error('timeout'); })), null);
});

test('协查未完成时不触发综合轮', async () => {
  const input = synthesisInput(async () => {
    assert.fail('未完成态不应触发综合轮');
  });
  input.outcome = makeOutcome({ state: 'failed', text: '', error: 'A2A timeout' });
  assert.equal(await synthesizeYachFollowupReply(input), null);
});
