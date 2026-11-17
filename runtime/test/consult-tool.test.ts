import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConsultationBrief, createConsultCompassTool } from '../src/capabilities/consult-tool.js';
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
