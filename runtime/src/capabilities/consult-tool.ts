import { z } from 'zod';

import { createTool } from '@mastra/core/tools';

import type { ConversationRecord, RemoteConclusion } from '../domain/schemas.js';
import type { CapabilityContext } from './session.js';
import {
  approveExternalConsultation,
  createExternalConsultation,
  markExternalConsultationSent,
  transitionExternalConsultation,
  type ExternalConsultation,
} from '../orchestration/consultation.js';
import type { AgentSlotRegistry } from '../orchestration/agent-slot-registry.js';

/**
 * consult_compass：把"跨侧协查"从 Supervisor 编排（分支 + 自动授权 + 联合阶段）
 * 改为模型可见工具。模型自主决定何时委派服务端/全栈排查；Runtime 保留：
 * 固定结构摘要（用户原文 + 明确问题）、轮次预算、发送前落库检查点、
 * 超时/截断/审计。完成态结论由观测注册表登记为正式观测（kind=external，
 * 可引用 ev-ID），与本地证据同级参与诊断。
 */

// 外发限长：只带用户原文和明确协查问题（与现行编排一致）。
const OUTBOUND_USER_MESSAGE_MAX = 2_000;
const OUTBOUND_USER_TOTAL_MAX = 8_000;
const OUTBOUND_QUESTION_MAX = 1_000;

function clipCodepoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…（截断）`;
}

/** 固定摘要构造：全部用户消息原文（逐条与总量限长）+ 模型给出的协查问题。 */
export function buildConsultationBrief(
  conversation: ConversationRecord,
  question: string,
  fallbackContent: string,
): string {
  const userMessages = conversation.messages
    .filter((message) => message.role === 'user' && message.content.trim())
    .map((message) => clipCodepoints(message.content.trim(), OUTBOUND_USER_MESSAGE_MAX));
  const userLines: string[] = [];
  let userTotal = 0;
  for (const [index, text] of userMessages.entries()) {
    if (userTotal + text.length > OUTBOUND_USER_TOTAL_MAX) {
      userLines.push(`…（其余 ${userMessages.length - index} 条用户消息超出外发长度上限，未包含）`);
      break;
    }
    userLines.push(userMessages.length > 1 ? `[${index + 1}] ${text}` : text);
    userTotal += text.length;
  }
  return [
    `用户问题原文：\n${userLines.join('\n') || clipCodepoints(fallbackContent, OUTBOUND_USER_MESSAGE_MAX)}`,
    `请协查的问题：\n${clipCodepoints(question, OUTBOUND_QUESTION_MAX)}`,
  ].join('\n\n');
}

function upsertConsultation(conversation: ConversationRecord, consultation: ExternalConsultation): void {
  const index = conversation.consultations.findIndex((item) => item.id === consultation.id);
  if (index < 0) conversation.consultations.push(consultation);
  else conversation.consultations[index] = consultation;
}

function upsertExternalFinding(conversation: ConversationRecord, finding: RemoteConclusion): void {
  const index = conversation.external_findings.findIndex((item) => item.consultation_id === finding.consultation_id);
  if (index < 0) conversation.external_findings.push(finding);
  else conversation.external_findings[index] = finding;
}

function parseCompassResult(value: unknown): {
  text: string;
  taskId: string | null;
  contextId: string | null;
  state: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Slot 返回结构无效');
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') throw new Error('Slot 返回缺少文本结论');
  return {
    text: record.text,
    taskId: typeof record.taskId === 'string' ? record.taskId : null,
    contextId: typeof record.contextId === 'string' ? record.contextId : null,
    state: typeof record.state === 'string' ? record.state : null,
  };
}

export function createConsultCompassTool(options: {
  conversation: ConversationRecord;
  messageId: string;
  runId: string;
  registry: AgentSlotRegistry;
  capabilityContext: CapabilityContext;
  saveConversation: (conversation: ConversationRecord) => Promise<void>;
  /** 本轮用户消息原文，用户消息缺失时的兜底。 */
  content: string;
  maxCalls?: number;
}): ReturnType<typeof createTool> {
  const {
    conversation, messageId, runId, registry, capabilityContext,
    saveConversation, content,
  } = options;
  const maxCalls = options.maxCalls ?? 4;
  let usedCalls = 0;

  return createTool({
    id: 'consult_compass',
    description:
      '把问题委派给统一外部全栈 Agent（Compass）协查服务端/前端/H5 侧。' +
      '本地证据指向服务端、或本地知识与源码不足以回答规则/实现查询时使用；' +
      'question 须写明具体协查问题，用户原文由 Runtime 自动附上。' +
      '完成态结论登记为正式观测（可引用 ev-ID），与本地证据同级使用。每轮调用次数有限，避免重复委派。',
    inputSchema: z.object({
      question: z.string().min(1).describe('具体的协查问题（含已知关键事实与缺口）'),
    }),
    execute: async (args) => {
      capabilityContext.abortSignal?.throwIfAborted();
      if (usedCalls >= maxCalls) {
        return {
          status: 'budget_exhausted',
          limitation: `本轮外部协查已达到 ${maxCalls} 次上限。请基于已有远端结论与本地证据收尾，或在下一轮再发起协查。`,
        };
      }
      usedCalls += 1;

      const brief = buildConsultationBrief(conversation, args.question, content);
      let consultation = approveExternalConsultation(
        createExternalConsultation({
          conversationId: conversation.id,
          messageId,
          runId,
          reason: `模型发起协查：${clipCodepoints(args.question, 120)}`,
          outboundText: brief,
          // Compass 及其模型链路均在内网，外发使用用户原文，不脱敏（2026-11-13 起）。
          redact: (text) => text,
        }),
        { conversationId: conversation.id, runId },
      );

      let slot;
      try {
        slot = await registry.resolve('compass', capabilityContext);
      } catch (error) {
        return {
          status: 'unavailable',
          limitation: `外部协查 Agent 不可用：${error instanceof Error ? error.message : String(error)}。请基于本地证据回答并说明该缺口。`,
        };
      }

      consultation = markExternalConsultationSent(consultation);
      upsertConsultation(conversation, consultation);
      // 发送检查点落库之前不得产生任何远端 HTTP。
      await saveConversation(conversation);

      const startedAt = Date.now();
      try {
        const result = await registry.invoke(slot, {
          text: consultation.outbound_text,
          contextId: consultation.context_id ?? undefined,
        }, capabilityContext);
        const data = parseCompassResult(result.data);
        conversation.slot_audit.push({
          operation: 'invoke',
          slotId: String(result.audit?.slotId ?? slot.slotId),
          taskId: typeof result.audit?.taskId === 'string' ? result.audit.taskId : data.taskId,
          state: typeof result.audit?.state === 'string' ? result.audit.state : data.state,
          durationMs: Number(result.audit?.durationMs ?? Date.now() - startedAt),
          truncated: Boolean(result.audit?.truncated ?? result.truncated),
        });
        const completed = data.state === 'TASK_STATE_COMPLETED';
        consultation = transitionExternalConsultation(
          consultation,
          completed ? 'completed' : 'failed',
          { taskId: data.taskId, contextId: data.contextId },
        );
        upsertConsultation(conversation, consultation);
        const finding: RemoteConclusion = {
          consultation_id: consultation.id,
          task_id: data.taskId,
          context_id: data.contextId,
          agent_id: slot.slotId,
          agent_version: null,
          state: data.state,
          text: data.text,
          truncated: result.truncated,
          scope: ['current_question', 'correlation'],
          limitations: result.limitations,
          request_digest: consultation.outbound_digest,
          received_at: new Date().toISOString(),
        };
        upsertExternalFinding(conversation, finding);
        await saveConversation(conversation);
        return {
          status: completed ? 'completed' : 'failed',
          conclusion: data.text,
          truncated: result.truncated,
          limitations: result.limitations,
          consultation_id: consultation.id,
        };
      } catch (error) {
        capabilityContext.abortSignal?.throwIfAborted();
        consultation = transitionExternalConsultation(consultation, 'unknown', { taskId: consultation.task_id });
        upsertConsultation(conversation, consultation);
        await saveConversation(conversation).catch(() => undefined);
        return {
          status: 'failed',
          limitation: `外部协查失败或超时，远端状态待确认：${error instanceof Error ? error.message : String(error)}。请基于本地证据收尾并说明该缺口。`,
          consultation_id: consultation.id,
        };
      }
    },
  });
}
