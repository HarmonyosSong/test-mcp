import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAguiEventBlock } from '../src/agui/events.ts';

const knownEvent = {
  type: 'TEXT_MESSAGE_CONTENT',
  run_id: 'run-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  message_id: 'message-1',
  delta: '仍在处理',
};

test('已知 AG-UI 事件仍按原契约解码', () => {
  assert.deepEqual(
    decodeAguiEventBlock(`data: ${JSON.stringify(knownEvent)}`),
    knownEvent,
  );
});

for (const type of ['INVESTIGATION_PLAN', 'BRANCH_STATUS', 'JOINT_ASSESSMENT', 'EXTERNAL_CONSULTATION_REQUIRED']) {
  test(`编排事件 ${type} 已退役：按未知事件静默忽略（兼容旧服务端/历史流）`, () => {
    const block = `data: ${JSON.stringify({ ...knownEvent, type })}`;
    assert.equal(decodeAguiEventBlock(block), null);
  });
}

test('旧前端兼容策略仍忽略真正未知的未来事件', () => {
  assert.equal(
    decodeAguiEventBlock('event: FUTURE_ORCHESTRATION_EVENT\ndata: {"plan": []}'),
    null,
  );
  assert.equal(
    decodeAguiEventBlock('data: {"type":"ANOTHER_FUTURE_EVENT","run_id":"run-1"}'),
    null,
  );
});

test('未知事件的非法 JSON 仍是协议错误', () => {
  assert.throws(
    () => decodeAguiEventBlock('event: FUTURE_ORCHESTRATION_EVENT\ndata: {not-json}'),
    SyntaxError,
  );
});

test('缺少事件类型的合法 JSON 仍是协议错误', () => {
  assert.throws(
    () => decodeAguiEventBlock('data: {"run_id":"run-1"}'),
    /无法识别的 AG-UI 事件/,
  );
});
