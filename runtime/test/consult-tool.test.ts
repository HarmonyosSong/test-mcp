import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConsultationBrief, composeFollowupMessage, createConsultCompassTool, createRequestCompassFollowupTool } from '../src/capabilities/consult-tool.js';
import { InMemoryAgentSlotRegistry } from '../src/orchestration/agent-slot-registry.js';
import { ConversationRecordSchema } from '../src/domain/schemas.js';

const timestamp = '2026-11-17T00:00:00.000Z';

function makeConversation(contents: string[]) {
  return ConversationRecordSchema.parse({
    id: 'conv-consult',
    title: 't',
    messages: contents.map((content, index) => ({
      id: `msg-${index}`,
      role: 'user',
      content,
      created_at: timestamp,
    })),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function makeSlotRegistry(overrides: {
  invokeResult?: unknown;
  invokeCalls?: unknown[];
} = {}) {
  const slot = {
    slotId: 'compass',
    agentCardUrl: 'http://compass.internal/agent',
    role: 'external' as const,
    capabilities: ['server'],
    authRef: 'token-ref',
    timeoutMs: 30_000,
    maxOutputChars: 8_000,
    evidenceMode: 'external_findings' as const,
  };
  const adapter = {
    async invoke(_slot: unknown, task: unknown) {
      overrides.invokeCalls?.push(task);
      if (overrides.invokeResult instanceof Error) throw overrides.invokeResult;
      return {
        data: overrides.invokeResult ?? {
          text: '远端结论：服务端校验逻辑在 v3.2 引入',
          taskId: 'task-1',
          contextId: 'ctx-1',
          state: 'TASK_STATE_COMPLETED',
        },
        truncated: false,
        limitations: [],
        audit: { slotId: 'compass', taskId: 'task-1', state: 'TASK_STATE_COMPLETED', durationMs: 12, truncated: false },
      };
    },
    async cancel() {},
  };
  return new InMemoryAgentSlotRegistry([{ slot, adapter }]);
}

function capabilityContext() {
  return {
    conversationId: 'conv-consult',
    messageId: 'msg-a',
    runId: 'run-1',
    workspacePath: null,
  };
}

function makeTool(options: {
  conversation: ReturnType<typeof makeConversation>;
  registry?: ReturnType<typeof makeSlotRegistry>;
  maxCalls?: number;
  saveLog?: string[];
}) {
  return createConsultCompassTool({
    conversation: options.conversation,
    messageId: 'msg-a',
    runId: 'run-1',
    registry: options.registry ?? makeSlotRegistry(),
    capabilityContext: capabilityContext(),
    content: options.conversation.messages.at(-1)?.content ?? '',
    saveConversation: async () => {
      options.saveLog?.push('save');
    },
    ...(options.maxCalls !== undefined ? { maxCalls: options.maxCalls } : {}),
  });
}

test('摘要只含用户原文与协查问题，逐条与总量限长', () => {
  const conversation = makeConversation(['甲'.repeat(3_000), '第二条']);
  const brief = buildConsultationBrief(conversation, '请核查作业提交接口', '兜底');
  assert.match(brief, /^用户问题原文：/);
  assert.match(brief, /请协查的问题：\n请核查作业提交接口/);
  assert.match(brief, /…（截断）/, '单条 2000 码点截断');
  const long = makeConversation(Array.from({ length: 10 }, () => '乙'.repeat(1_500)));
  const longBrief = buildConsultationBrief(long, 'q', '兜底');
  assert.match(longBrief, /未包含/, '总量超限时标注未包含条数');
});

test('知音楼群聊消息剥离上下文段，外发只带当前提问', () => {
  const groupMessage = [
    '下面是本群近 30 分钟内通过开放平台拉取的群聊记录摘要，请优先据此回答与群消息相关的问题。',
    '',
    '【群聊近期上下文】',
    '张鑫鑫: 学员编号：253010882384 日历打开了还是没发同步课程表',
    '张鑫鑫: iOS 课程日历同步到系统的逻辑是什么',
    '',
    '【当前提问】',
    '@培优问题排查助手 鸿蒙端7.105.0学而思app 跨报成功记录多退少补不展示「去结算」按钮',
  ].join('\n');
  const conversation = makeConversation([groupMessage]);
  const brief = buildConsultationBrief(conversation, '请核查去结算按钮展示条件', '兜底');
  assert.match(brief, /跨报成功记录多退少补不展示/);
  assert.doesNotMatch(brief, /群聊近期上下文/, '不得外发群聊上下文标记');
  assert.doesNotMatch(brief, /日历打开了还是没发同步/, '不得外发群内无关问题');
  assert.doesNotMatch(brief, /日历同步到系统的逻辑/, '不得外发群内其他提问');

  // 无标记的普通消息（web 渠道）原样透传
  const plain = makeConversation(['直接的用户提问原文']);
  assert.match(buildConsultationBrief(plain, 'q', '兜底'), /直接的用户提问原文/);

  // fallback（user 消息为空）同样剥离
  const empty = makeConversation(['']);
  const fallbackBrief = buildConsultationBrief(empty, 'q', groupMessage);
  assert.match(fallbackBrief, /跨报成功记录多退少补不展示/);
  assert.doesNotMatch(fallbackBrief, /日历同步到系统的逻辑/);
});

test('成功协查：咨询记录直写 approved→sent→completed，审计与外部结论落库', async () => {
  const conversation = makeConversation(['鸿蒙 3.2.1 提交作业失败']);
  const invokeCalls: unknown[] = [];
  const saveLog: string[] = [];
  const tool = makeTool({ conversation, registry: makeSlotRegistry({ invokeCalls }), saveLog });
  const result = await tool.execute!({ question: '请核查服务端作业提交校验' }, {} as never) as Record<string, unknown>;
  assert.equal(result.status, 'completed');
  assert.match(String(result.conclusion), /远端结论/);
  assert.equal(result.note, undefined, '协查结论不再附带「未验证」降级标注');
  assert.equal(result.consultation_id, conversation.consultations[0]?.id);
  // 任务文本 = 固定摘要，模型只贡献了 question。
  assert.match(String((invokeCalls[0] as { text: string }).text), /用户问题原文/);
  // 无 pending 停留：最终记录为 completed，全程一次 sent 检查点 + 一次终态落库。
  assert.equal(conversation.consultations.length, 1);
  assert.equal(conversation.consultations[0]?.status, 'completed');
  assert.equal(conversation.external_findings.length, 1);
  assert.equal(conversation.external_findings[0]?.task_id, 'task-1');
  assert.equal(conversation.slot_audit.length, 1);
  assert.equal(conversation.slot_audit[0]?.operation, 'invoke');
  assert.equal(saveLog.length, 2);
});

test('轮次预算耗尽后软返回，不再发起远端调用', async () => {
  const conversation = makeConversation(['问题']);
  const invokeCalls: unknown[] = [];
  const tool = makeTool({ conversation, registry: makeSlotRegistry({ invokeCalls }), maxCalls: 1 });
  await tool.execute!({ question: '第一次' }, {} as never);
  const second = await tool.execute!({ question: '第二次' }, {} as never) as Record<string, unknown>;
  assert.equal(second.status, 'budget_exhausted');
  assert.equal(invokeCalls.length, 1);
});

test('远端失败：咨询记录转 unknown，返回缺口说明而不抛错', async () => {
  const conversation = makeConversation(['问题']);
  const tool = makeTool({
    conversation,
    registry: makeSlotRegistry({ invokeResult: new Error('A2A timeout') }),
  });
  const result = await tool.execute!({ question: 'q' }, {} as never) as Record<string, unknown>;
  assert.equal(result.status, 'failed');
  assert.match(String(result.limitation), /远端状态待确认/);
  assert.equal(conversation.consultations[0]?.status, 'unknown');
});

test('Slot 未注册时返回 unavailable', async () => {
  const conversation = makeConversation(['问题']);
  const tool = makeTool({ conversation, registry: new InMemoryAgentSlotRegistry([]) });
  const result = await tool.execute!({ question: 'q' }, {} as never) as Record<string, unknown>;
  assert.equal(result.status, 'unavailable');
  assert.equal(conversation.consultations.length, 0);
});

// ———— request_compass_followup（异步协查） ————

test('后台协查：发起即返回 started，不落等待；重复发起被拒', async () => {
  const conversation = makeConversation(['学员 uid 5570040 磨耳朵停播']);
  const saveLog: string[] = [];
  const followupState: { handle: import('../src/capabilities/consult-tool.js').CompassFollowupHandle | null } = { handle: null };
  let resolveRemote!: (value: import('../src/orchestration/agent-slot-registry.js').CapabilityResult) => void;
  const slot = {
    slotId: 'compass',
    agentCardUrl: 'http://compass.internal/agent',
    role: 'external' as const,
    capabilities: ['server'],
    authRef: 'token-ref',
    timeoutMs: 30_000,
    maxOutputChars: 8_000,
    evidenceMode: 'external_findings' as const,
  };
  const adapter = {
    invoke: () => new Promise<import('../src/orchestration/agent-slot-registry.js').CapabilityResult>((resolve) => { resolveRemote = resolve; }),
    async cancel() {},
  };
  const registry = new InMemoryAgentSlotRegistry([{ slot, adapter }]);
  const tool = createRequestCompassFollowupTool({
    conversation,
    messageId: 'msg-a',
    runId: 'run-1',
    registry,
    capabilityContext: capabilityContext(),
    content: '学员 uid 5570040 磨耳朵停播',
    saveConversation: async () => { saveLog.push('save'); },
    followupState,
  });

  const started = await tool.execute!({ question: '请核查播放心跳接口' }, {} as never) as { status: string };
  assert.equal(started.status, 'started');
  assert.ok(saveLog.length >= 1, '发送检查点已落库');
  assert.ok(followupState.handle, '已登记后台句柄');
  const consultation = conversation.consultations.at(-1)!;
  assert.equal(consultation.status, 'sent');

  const again = await tool.execute!({ question: '重复问题' }, {} as never) as { status: string };
  assert.equal(again.status, 'already_started');

  // 远端尚未返回时 promise 挂起；返回后产出 completed 结果与消息文案。
  let settled = false;
  void followupState.handle.promise.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  resolveRemote({
    data: { text: '服务端确认心跳超时阈值过短', taskId: 'task-9', contextId: 'ctx-9', state: 'TASK_STATE_COMPLETED' },
    truncated: false,
    limitations: [],
    audit: { slotId: 'compass', taskId: 'task-9', state: 'TASK_STATE_COMPLETED', durationMs: 5, truncated: false },
  });
  const outcome = await followupState.handle.promise;
  assert.equal(outcome.state, 'completed');
  const message = composeFollowupMessage(outcome);
  assert.match(message, /【服务端协查结果】/);
  assert.match(message, /心跳超时阈值过短/);
});

test('后台协查：远端失败时产出失败文案', async () => {
  const conversation = makeConversation(['q']);
  const followupState: { handle: import('../src/capabilities/consult-tool.js').CompassFollowupHandle | null } = { handle: null };
  const registry = makeSlotRegistry({ invokeResult: new Error('A2A timeout') });
  const tool = createRequestCompassFollowupTool({
    conversation,
    messageId: 'msg-a',
    runId: 'run-1',
    registry,
    capabilityContext: capabilityContext(),
    content: 'q',
    saveConversation: async () => {},
    followupState,
  });
  const started = await tool.execute!({ question: 'q' }, {} as never) as { status: string };
  assert.equal(started.status, 'started');
  const outcome = await followupState.handle!.promise;
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.error!, /A2A timeout/);
  assert.match(composeFollowupMessage(outcome), /协查超时或失败/);
});
