import assert from 'node:assert/strict';
import test from 'node:test';

import { isTopicSwitch } from '../src/channels/yach/topic-switch.js';

const base = {
  historyUserTexts: ['北京 165010784572 刘佳怡 支付过程中出现问题2 请查一下'],
  conversationUpdatedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 分钟前
};

test('换题词开头 → 切题', () => {
  assert.equal(isTopicSwitch({ ...base, text: '新问题：uid 12345678 登录失败' }), true);
  assert.equal(assertSwitch('另外帮我看一个情况'), true);
  assert.equal(assertSwitch('还有一个问题'), true);
});

test('当前学员编号与历史无交集 → 切题', () => {
  assert.equal(assertSwitch('上海 199020887654 王小明 提交作业失败'), true);
});

test('同学员追问 → 不切（即使超过 30 分钟）', () => {
  assert.equal(assertSwitch('165010784572 这个学员后来支付成功了嘛', 45 * 60_000), false);
});

test('无编号且间隔短 → 追问，不切', () => {
  assert.equal(assertSwitch('那他现在的订单状态是什么'), false);
});

test('无编号且超过 30 分钟 → 切题', () => {
  assert.equal(assertSwitch('磨耳朵音频打不开怎么回事', 31 * 60_000), true);
});

test('显式 uid 写法参与比对；裸数字不算 uid', () => {
  assert.equal(
    isTopicSwitch({ ...base, text: 'uid 2592373 后来怎么样了', historyUserTexts: ['uid 2592373 支付失败'] }),
    false,
  );
  assert.equal(
    isTopicSwitch({ ...base, text: 'uid 9998877 登录不了', historyUserTexts: ['uid 2592373 支付失败'] }),
    true,
  );
});

test('历史无编号时当前含编号 → 切题（全新话题）', () => {
  assert.equal(
    isTopicSwitch({ text: '北京 165010784572 支付失败', historyUserTexts: ['你好'], conversationUpdatedAt: base.conversationUpdatedAt }),
    true,
  );
});

function assertSwitch(text: string, gapMs = 5 * 60_000): boolean {
  return isTopicSwitch({
    ...base,
    text,
    conversationUpdatedAt: new Date(Date.now() - gapMs).toISOString(),
  });
}
