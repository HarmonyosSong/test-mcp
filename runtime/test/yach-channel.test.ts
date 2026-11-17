import assert from 'node:assert/strict';
import test from 'node:test';

import { formatYachFinalReply } from '../src/channels/yach/channel.js';
import { IM_MESSAGE_LIMIT } from '../src/channels/yach/cli.js';

test('知音楼发送校验后的最终回答全文，首行判定锚点即结论标签', () => {
  const text = '判定：可能定位\n启动白屏源于 LoginPage.ets:42 访问缺失字段抛出 TypeError。\n仍需补充：当前版本号。';
  const reply = formatYachFinalReply(text, 'http://127.0.0.1:5174/xesapp-agent/');

  assert.match(reply, /^判定：可能定位/);
  assert.match(reply, /LoginPage\.ets:42/);
  assert.match(reply, /补充：当前版本号/);
  assert.match(reply, /完整报告请打开工作台：http:\/\/127\.0\.0\.1:5174\/xesapp-agent\//);
});

test('判定锚点缺失时只发兜底句，不放出未校验文本', () => {
  const reply = formatYachFinalReply('没有锚点的回答正文', '/xesapp-agent/');
  assert.match(reply, /诊断已完成，请打开工作台查看详情/);
  assert.doesNotMatch(reply, /没有锚点的回答正文/);

  const empty = formatYachFinalReply('', '/xesapp-agent/');
  assert.match(empty, /诊断已完成，请打开工作台查看详情/);
  const missing = formatYachFinalReply(null, '/xesapp-agent/');
  assert.match(missing, /诊断已完成，请打开工作台查看详情/);
});

test('超长回答截断到 IM 上限并保留工作台链接', () => {
  const text = `判定：已定位\n${'很长的结论。'.repeat(2000)}`;
  const reply = formatYachFinalReply(text, 'http://127.0.0.1:5174/xesapp-agent/');
  assert.ok(reply.length <= IM_MESSAGE_LIMIT + 100);
  assert.match(reply, /已截断/);
  assert.match(reply, /完整报告请打开工作台/);
});
