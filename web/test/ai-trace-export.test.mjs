import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUsage, tracesToMarkdown } from '../src/components/chat/aiTraceExport.ts';

const summary = {
  ts: '2026-11-20_09-49-38',
  trace_id: 'abc123',
  message_id: 'msg-1',
  summary: { duration_ms: 25_972, steps: 2, tool_calls: 1 },
};

const detail = {
  conversation_id: 'conv-1',
  message_id: 'msg-1',
  trace_id: 'abc123',
  captured_at: '2026-11-20T01:49:38Z',
  model: 'deepseek-flash',
  user_input: '支付过程中出现问题2',
  final_answer: '判定：可能定位\n……',
  steps: [
    {
      step_index: 0,
      duration_ms: 1166,
      finish_reason: 'tool-calls',
      usage: { inputTokens: 2554, outputTokens: 132, inputDetails: { cacheRead: 0, text: 2554 } },
      tools: [
        {
          name: 'search_project_text',
          kind: 'tool',
          duration_ms: 1166,
          success: true,
          input_preview: '{"query":"doTrade"}',
          output_preview: '{"matches":[…]}',
        },
      ],
    },
    {
      step_index: 1,
      duration_ms: 800,
      finish_reason: 'stop',
      model_text: 'orderInfo 由收银台拼接……',
      tools: [],
    },
  ],
};

test('formatUsage 展示输入（新内容/缓存）与输出', () => {
  assert.equal(
    formatUsage({ inputTokens: 2554, outputTokens: 132, inputDetails: { cacheRead: 0, text: 2554 } }),
    '输入 2,554（新 2,554） / 输出 132 tok',
  );
  assert.equal(
    formatUsage({ inputTokens: 4484, outputTokens: 219, inputDetails: { cacheRead: 2560, text: 1924 } }),
    '输入 4,484（新 1,924，缓存 2,560） / 输出 219 tok',
  );
  assert.equal(formatUsage(undefined), null);
  assert.equal(formatUsage({}), null);
});

test('tracesToMarkdown 含会话信息、轮次、输入输出与工具明细', () => {
  const md = tracesToMarkdown('conv-1', [{ summary, detail }]);
  assert.match(md, /会话：conv-1/);
  assert.match(md, /## 轮次 2026-11-20_09-49-38（abc123）/);
  assert.match(md, /模型：deepseek-flash/);
  assert.match(md, /### 用户输入\n\n```\n支付过程中出现问题2\n```/);
  assert.match(md, /### 最终回答/);
  assert.match(md, /#### 工具 search_project_text ✓ · 1166ms/);
  assert.match(md, /入参：\n```\n\{"query":"doTrade"\}\n```/);
  assert.match(md, /输入 2,554（新 2,554） \/ 输出 132 tok/);
  assert.match(md, /模型输出：\n```\norderInfo 由收银台拼接……\n```/);
});
