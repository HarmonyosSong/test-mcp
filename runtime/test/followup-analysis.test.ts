import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeFollowupWithSource } from '../src/diagnosis/followup-analysis.js';
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
