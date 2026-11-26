import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendArchiveSection,
  archiveAckText,
  findArchivableMessage,
  isFaultFinalAnswer,
  parseArchiveFeedback,
} from '../src/channels/yach/archive.js';
import type { ChatMessage } from '../src/domain/schemas.js';

test('归档回执精确匹配：trim 后等于「问题分析正确/失败」才识别', () => {
  assert.equal(parseArchiveFeedback('问题分析正确'), 'correct');
  assert.equal(parseArchiveFeedback('问题分析失败'), 'failed');
  assert.equal(parseArchiveFeedback('  问题分析正确\n'), 'correct');
  assert.equal(parseArchiveFeedback('问题分析正确吗'), null);
  assert.equal(parseArchiveFeedback('这个问题分析失败了'), null);
  assert.equal(parseArchiveFeedback(''), null);
});

test('故障终稿判定：四种结论锚点命中，信息查询/初步判定/无锚点不命中', () => {
  assert.ok(isFaultFinalAnswer('判定：已定位\n【问题原因】…'));
  assert.ok(isFaultFinalAnswer('判定：可能定位\n【问题原因】…'));
  assert.ok(isFaultFinalAnswer('判定：证据不足\n【问题原因】…'));
  assert.ok(isFaultFinalAnswer('判定：工具异常\n【问题原因】…'));
  // 综合轮首行前可能有空白，容忍前导空白。
  assert.ok(isFaultFinalAnswer('\n判定：已定位\n【问题原因】…'));

  assert.ok(!isFaultFinalAnswer('判定：信息查询\n【学员信息】…'));
  assert.ok(!isFaultFinalAnswer('判定：可能定位（初步）\n【问题原因】…'));
  assert.ok(!isFaultFinalAnswer('判定：已定位(初步)\n【问题原因】…'));
  assert.ok(!isFaultFinalAnswer('好的，我来继续看一下。'));
});

test('归档区追加在正文末尾，含两个快捷回复链接', () => {
  const reply = appendArchiveSection('判定：已定位\n正文。', 5000);
  assert.match(reply, /^判定：已定位/);
  assert.match(reply, /【问题归档】/);
  assert.match(reply, /\[问题分析正确\]\(yach:\/\/yach\.zhiyinlou\.com\/session\/robot\?type=fold&extra=\{\}&reply=问题分析正确\)/);
  assert.match(reply, /\[问题分析失败\]\(yach:\/\/[^)]*reply=问题分析失败\)/);
  assert.ok(reply.trimEnd().endsWith('reply=问题分析失败)'), '归档区必须在末尾');
});

test('归档区优先保留：正文超长时先裁正文，整体不超上限', () => {
  const limit = 500;
  const reply = appendArchiveSection(`判定：已定位\n${'很长的结论。'.repeat(200)}`, limit);
  assert.ok(reply.length <= limit, `超长: ${reply.length}`);
  assert.match(reply, /已截断/);
  assert.match(reply, /【问题归档】/);
  assert.ok(reply.trimEnd().endsWith('reply=问题分析失败)'), '归档区必须完整保留在末尾');
});

test('归档确认回执区分正确/失败', () => {
  assert.match(archiveAckText('correct'), /问题分析正确/);
  assert.match(archiveAckText('failed'), /问题分析失败/);
});

function assistantMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    steps: [],
    status: 'completed',
    error: null,
    report: null,
    input_tokens: null,
    output_tokens: null,
    context_tokens: null,
    context_cache_read_tokens: null,
    analysis_feedback: null,
    tool_usage: {},
    created_at: '2026-11-26T10:00:00.000Z',
  };
}

test('归档回写目标：最近一条故障终稿，跳过初步判定与信息查询', () => {
  const messages = [
    assistantMessage('m1', '判定：已定位\n第一条终稿。'),
    assistantMessage('m2', '判定：可能定位（初步）\n初步判定，协查在途。'),
    assistantMessage('m3', '判定：已定位\n综合终稿。'),
  ];
  assert.equal(findArchivableMessage(messages)?.id, 'm3');

  const onlyPreliminary = [
    assistantMessage('m1', '判定：可能定位（初步）\n初步判定。'),
    assistantMessage('m2', '判定：信息查询\n【学员信息】…'),
  ];
  assert.equal(findArchivableMessage(onlyPreliminary), null);
});
