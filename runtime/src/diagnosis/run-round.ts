import { randomUUID } from 'node:crypto';

import type {
  ChatMessage,
  ConversationRecord,
} from '../domain/schemas.js';
import type { CapabilityMcp } from '../capabilities/mcp.js';
import { createRoundCapabilitySession, type CapabilitySession, type CapabilityContext } from '../capabilities/session.js';
import type { ToolsetsInput } from '@mastra/core/agent';
import { createLazySourceToolset, LazySourceHolder } from '../capabilities/lazy-source.js';
import { createPrepareSourceTool } from '../capabilities/prepare-source-tool.js';
import {
  composeFollowupMessage,
  createConsultCompassTool,
  createRequestCompassFollowupTool,
  type CompassFollowupOutcome,
  type CompassFollowupState,
} from '../capabilities/consult-tool.js';
import {
  transitionExternalConsultation,
  type ExternalConsultation,
} from '../orchestration/consultation.js';
import type { RemoteConclusion } from '../domain/schemas.js';
import type { BoundSourceContext } from '../capabilities/source-binding.js';
import { prepareConversationSource } from '../capabilities/prepare-source.js';
import type { ModelConfiguration } from '../model/configuration.js';
import type { ProductStore } from '../product/store.js';
import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../security/redaction.js';
import { appendDiagnosisOutcome, archiveDiagnosisCase } from '../observability/cases.js';
import { recordConversationEvent } from '../observability/conversation-span-file-exporter.js';
import { DiagnosisAgent, type DiagnosisStreamEvent } from './agent.js';
import { analyzeFollowupWithSource, synthesizeYachFollowupReply } from './followup-analysis.js';
import { createStreamRedactor } from '../security/stream-redaction.js';
import type { AgentSlotRegistry } from '../orchestration/agent-slot-registry.js';

/** 轮次预算：软时限（到期关闭工具收尾）+ 外部协查次数。 */
export type InvestigationBudget = { maxSeconds: number; maxRemoteCalls: number };

const DEFAULT_INVESTIGATION_BUDGET: InvestigationBudget = { maxSeconds: 900, maxRemoteCalls: 4 };
/** 软时限后的收尾窗口：宽限模型用已有证据产出最终回答，之后硬 abort 兜底。 */
const FINALIZE_WINDOW_SECONDS = 180;

export interface RunDiagnosisRoundOptions {
  knowledgeQueryLog?: string;
  caseArchiveDir?: string;
  slotRegistry?: AgentSlotRegistry;
  /** Compass A2A 配置完成才挂载 consult_compass 工具（工具可用性即能力边界）。 */
  compassAvailable?: boolean;
  investigationBudget?: InvestigationBudget;
  /** 后台协查（request_compass_followup）出结果后回调：知音楼用来主动推送，web 缺省只落库。 */
  onCompassFollowupSettled?: (info: {
    conversation: ConversationRecord;
    message: ChatMessage;
    outcome: CompassFollowupOutcome;
  }) => void | Promise<void>;
  /** Bind a read-only source snapshot after logs reveal the real client/version. */
  createConversationSource?: (input: {
    platform: Exclude<ConversationRecord['platform'], null>;
    productLine: ConversationRecord['product_line'];
    formFactor: ConversationRecord['form_factor'];
    version: ConversationRecord['version'];
    build: ConversationRecord['build'];
    boundSource?: BoundSourceContext;
    signal?: AbortSignal;
  }) => Promise<Partial<Pick<ConversationRecord, 'workspace_path' | 'repository_id' | 'repository_name' | 'requested_ref' | 'resolved_commit' | 'source_repositories' | 'source_completeness' | 'source_limitations' | 'platform' | 'product_line' | 'form_factor' | 'version' | 'build'>>>;
}

export interface RunDiagnosisRoundInput {
  store: ProductStore;
  diagnosisAgent: DiagnosisAgent;
  capabilities: CapabilityMcp;
  modelConfiguration: ModelConfiguration;
  conversation: ConversationRecord;
  content: string;
  runId?: string;
  abortSignal?: AbortSignal;
  onPrepared?: (info: {
    conversation: ConversationRecord;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    runId: string;
  }) => void | Promise<void>;
  onEvent?: (event: DiagnosisStreamEvent) => void | Promise<void>;
  options?: RunDiagnosisRoundOptions;
  prepared?: PreparedDiagnosisRound;
}

export interface PreparedDiagnosisRound {
  conversation: ConversationRecord;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  runId: string;
}

export interface RunDiagnosisRoundResult {
  conversation: ConversationRecord;
  assistantMessage: ChatMessage;
  runId: string;
  terminal: 'completed' | 'failed';
  terminalPersisted: boolean;
  text: string;
  /** 本轮发起了后台协查且结果待同步。 */
  compassFollowupPending: boolean;
}

async function persistTerminalConversation(
  save: (conversation: ConversationRecord) => Promise<void>,
  conversation: ConversationRecord,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await save(conversation);
      return;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  throw lastError;
}

async function recordTerminalCase(
  options: RunDiagnosisRoundOptions,
  conversation: ConversationRecord,
  messageId: string,
  verdict: string | null,
  outcome: 'completed' | 'failed',
  redact: (text: string) => string,
): Promise<void> {
  await Promise.allSettled([
    archiveDiagnosisCase(options.caseArchiveDir ?? '.data/knowledge-cases', conversation, messageId, redact),
    appendDiagnosisOutcome(options.knowledgeQueryLog ?? '.data/knowledge-queries.jsonl', conversation.id, messageId, verdict, outcome),
  ]);
}

/** 会话时间线事件：settle 流程的编排事实落盘（协查发起/回执/分析轮跳过等），best-effort。 */
function emitFollowupEvent(
  conversationId: string,
  conversationCreatedAt: string | null | undefined,
  event: {
    kind: string;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
    at?: string;
  },
): void {
  void recordConversationEvent(conversationId, conversationCreatedAt, event).catch(() => undefined);
}

/** 有序落盘版本：同一 settle 内先后两件事实必须保证 events.jsonl 文件顺序即发生顺序。 */
async function emitFollowupEventOrdered(
  conversationId: string,
  conversationCreatedAt: string | null | undefined,
  event: {
    kind: string;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
    at?: string;
  },
): Promise<void> {
  await recordConversationEvent(conversationId, conversationCreatedAt, event).catch(() => undefined);
}

/** 后台协查收尾：等远端出结果 → 更新 consultation/finding → 追加协查消息 → 落库 → 回调渠道。 */
function scheduleCompassFollowupSettle(input: {
  store: ProductStore;
  redact: (text: string) => string;
  conversationId: string;
  followupState: CompassFollowupState;
  options?: RunDiagnosisRoundOptions;
  /** 协查成功后的客户端侧源码交叉分析；返回 null 表示无可分析内容（含纯服务端原因）。 */
  analyzeFollowup?: (info: {
    conversation: ConversationRecord;
    outcome: CompassFollowupOutcome;
  }) => Promise<{ text: string; inputTokens: number | null; outputTokens: number | null } | null>;
  /** 知音楼渠道：把初步判定+协查结论+客户端分析综合成模板 v2 终稿；null 回退拼装文案。 */
  synthesizeYachReply?: (info: {
    conversation: ConversationRecord;
    outcome: CompassFollowupOutcome;
    analysis: string | null;
  }) => Promise<{ text: string; inputTokens: number | null; outputTokens: number | null } | null>;
}): void {
  const handle = input.followupState.handle;
  if (!handle) return;
  const settle = async () => {
    const outcome = await handle.promise;
    // 重新拉取会话：协查等待期间用户可能已开始下一轮，不能用旧对象覆盖。
    const conversation = await input.store.getConversation(input.conversationId);
    // 时间线事件：协查发起与回执（等待期间主轮 trace 早已封盘，只能靠事件通道看见这段）。
    // 两条顺序落盘，保证 events.jsonl 文件顺序即发生顺序。
    await emitFollowupEventOrdered(conversation.id, conversation.created_at, {
      kind: 'compass_followup_sent',
      title: '发起服务端协查',
      detail: handle.question,
      data: { consultation_id: handle.consultationId },
      at: handle.startedAt,
    });
    await emitFollowupEventOrdered(conversation.id, conversation.created_at, {
      kind: 'compass_followup_settled',
      title: outcome.state === 'completed' ? '服务端协查回执（完成）' : `服务端协查回执（${outcome.state}）`,
      detail: outcome.text || outcome.error || '',
      data: {
        consultation_id: handle.consultationId,
        task_id: outcome.taskId,
        state: outcome.state,
        wait_ms: Date.now() - new Date(handle.startedAt).getTime(),
        truncated: outcome.truncated,
      },
    });
    const index = conversation.consultations.findIndex((item) => item.id === handle.consultationId);
    if (index >= 0) {
      conversation.consultations[index] = transitionExternalConsultation(
        conversation.consultations[index] as ExternalConsultation,
        outcome.state === 'completed' ? 'completed' : 'failed',
        { taskId: outcome.taskId, contextId: outcome.contextId },
      );
    }
    const consultation = conversation.consultations.find((item) => item.id === handle.consultationId);
    if (outcome.state === 'completed' && consultation) {
      const finding: RemoteConclusion = {
        consultation_id: handle.consultationId,
        task_id: outcome.taskId,
        context_id: outcome.contextId,
        agent_id: 'compass',
        agent_version: null,
        state: 'TASK_STATE_COMPLETED',
        text: outcome.text,
        truncated: outcome.truncated,
        scope: ['current_question', 'correlation'],
        limitations: outcome.limitations ?? [],
        request_digest: consultation.outbound_digest,
        received_at: new Date().toISOString(),
      };
      const findingIndex = conversation.external_findings.findIndex(
        (item) => item.consultation_id === handle.consultationId,
      );
      if (findingIndex < 0) conversation.external_findings.push(finding);
      else conversation.external_findings[findingIndex] = finding;
    }
    // 协查成功时尝试客户端侧源码交叉分析（纯服务端原因/失败时返回 null，消息保持纯转发）。
    const analysis = input.analyzeFollowup
      ? await input.analyzeFollowup({ conversation, outcome }).catch(() => null)
      : null;
    // 知音楼渠道：第二轮改发模板 v2 综合终稿（初步判定+协查结论+分析），失败回退拼装文案。
    const synthesis = conversation.channel === 'yach_im' && outcome.state === 'completed' && input.synthesizeYachReply
      ? await input.synthesizeYachReply({ conversation, outcome, analysis: analysis?.text ?? null }).catch(() => null)
      : null;
    const sumTokens = (
      a: number | null | undefined,
      b: number | null | undefined,
    ): number | null => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    const message: ChatMessage = {
      id: `msg-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      role: 'assistant',
      content: synthesis?.text ?? composeFollowupMessage(outcome, analysis?.text),
      steps: [],
      status: 'completed',
      error: null,
      report: null,
      input_tokens: sumTokens(analysis?.inputTokens, synthesis?.inputTokens),
      output_tokens: sumTokens(analysis?.outputTokens, synthesis?.outputTokens),
      tool_usage: {
        compass_followup: 1,
        ...(analysis ? { followup_analysis: 1 } : {}),
        ...(synthesis ? { followup_synthesis: 1 } : {}),
      },
      created_at: new Date().toISOString(),
    };
    conversation.messages.push(message);
    conversation.updated_at = new Date().toISOString();
    await input.store.saveConversation(redactConversationForPersistence(conversation, input.redact));
    await input.options?.onCompassFollowupSettled?.({ conversation, message, outcome });
  };
  void settle().catch(() => {
    // 协查收尾失败不拖累主流程；consultation 停留在 sent，重启后按中断修复。
  });
}

function newAssistantMessage(): ChatMessage {  return {
    id: `msg-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    role: 'assistant',
    content: '',
    steps: [],
    status: 'streaming',
    error: null,
    report: null,
    input_tokens: null,
    output_tokens: null,
    tool_usage: {},
    created_at: new Date().toISOString(),
  };
}

function redactConversationForPersistence(
  conversation: ConversationRecord,
  redact: (text: string) => string,
): ConversationRecord {
  // 用户原文仍由会话所有者保存，后续轮次身份识别依赖它；2026-11-13 起 redact 为透传（内网不脱敏），
  // redactRecordInPlace 实际不再改写内容，保留调用以维持持久化边界。
  const originals = new Map(conversation.messages.map((message) => [message.id, message.content]));
  // 外发摘要与用户原文同级（内网全链路），持久化保留实际发送的原文，保持与 digest 一致。
  const outboundOriginals = new Map(conversation.consultations.map((item) => [item.id, item.outbound_text]));
  const result = redactRecordInPlace(conversation, redact);
  for (const message of result.messages) {
    if (message.role === 'user') message.content = originals.get(message.id) ?? message.content;
  }
  for (const consultation of result.consultations) {
    consultation.outbound_text = outboundOriginals.get(consultation.id) ?? consultation.outbound_text;
  }
  return result;
}

function roundRedactor(
  modelConfiguration: ModelConfiguration,
  _conversation: ConversationRecord,
  _content: string,
): (text: string) => string {
  return (text: string) => modelConfiguration.redact?.(text) ?? redactSensitiveText(text);
}

/** Persist admission before Web sends HTTP 200 or starts any capability clients. */
export async function prepareDiagnosisRound(
  input: Pick<RunDiagnosisRoundInput, 'store' | 'modelConfiguration' | 'content' | 'conversation' | 'runId'>,
): Promise<PreparedDiagnosisRound> {
  const { store, modelConfiguration } = input;
  const redact = roundRedactor(modelConfiguration, input.conversation, input.content);
  const saveConversation = async (conversation: ConversationRecord) => {
    await store.saveConversation(redactConversationForPersistence(conversation, redact));
  };
  const conversation = input.conversation;
  const runId = input.runId ?? `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  const content = modelConfiguration.redact?.(input.content) ?? redactSensitiveText(input.content);
  const userMessage: ChatMessage = {
    id: `msg-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    role: 'user',
    content,
    steps: [],
    status: 'completed',
    error: null,
    report: null,
    input_tokens: null,
    output_tokens: null,
    tool_usage: {},
    created_at: new Date().toISOString(),
  };
  const assistantMessage = newAssistantMessage();
  conversation.messages.push(userMessage, assistantMessage);
  if (conversation.title === '新会话') {
    conversation.title = content.length > 30 ? `${content.slice(0, 30)}…` : content;
  }
  conversation.updated_at = new Date().toISOString();
  await saveConversation(conversation);

  return { conversation, userMessage, assistantMessage, runId };
}

/**
 * 单 loop 诊断轮次（去编排化后的唯一路径，Web 与知音楼 IM 共用）。
 *
 * 不再有 Supervisor/分支/阶段：准入与持久化占位后，一次性 agent.stream，
 * 模型在护栏（RoundGuard：串行/缓存/失败防重试/无进展提醒/软时限）内自主完成
 * 知识检索 → 日志观察 → prepare_source 绑定快照 → 读码 → 按需 consult_compass →
 * 含判定锚点的最终回答。最终回答经 FinalAnswerValidator 校验后才放出（agent 内缓冲）。
 */
export async function runDiagnosisRound(input: RunDiagnosisRoundInput): Promise<RunDiagnosisRoundResult> {
  const prepared = input.prepared ?? await prepareDiagnosisRound(input);
  const { store, diagnosisAgent, capabilities, modelConfiguration, onPrepared, onEvent, options = {} } = input;
  const budget = options.investigationBudget ?? DEFAULT_INVESTIGATION_BUDGET;
  const redact = roundRedactor(modelConfiguration, input.conversation, input.content);
  const streamRedactor = createStreamRedactor(redact);
  const saveConversation = async (conversation: ConversationRecord) => {
    await store.saveConversation(redactConversationForPersistence(conversation, redact));
  };
  const { conversation, assistantMessage, runId } = prepared;
  const content = prepared.userMessage.content;
  await onPrepared?.(prepared);

  // 两段式时限：软时限关闭工具让模型收尾，收尾窗后硬 abort 兜底。
  const softDeadlineAt = Date.now() + budget.maxSeconds * 1_000;
  const hardDeadline = AbortSignal.timeout((budget.maxSeconds + FINALIZE_WINDOW_SECONDS) * 1_000);
  const abortSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, hardDeadline])
    : hardDeadline;

  let text = '';
  let capabilitySession: CapabilitySession | undefined;
  let sourceHolder: LazySourceHolder | undefined;
  const followupState: CompassFollowupState = { handle: null };
  let terminal: 'completed' | 'failed' | null = null;
  let terminalPersisted = false;

  try {
    // 轮首最佳努力绑定：显式带版本的提问省一轮工具往返；歧义/缺口转为 limitations。
    await prepareConversationSource(conversation, content, options.createConversationSource, abortSignal);
    await saveConversation(conversation);

    sourceHolder = new LazySourceHolder(capabilities, conversation.id);
    if (conversation.workspace_path) {
      try {
        await sourceHolder.bind(conversation.workspace_path);
      } catch {
        // 快照目录失效等异常不阻断本轮：代理工具将返回 unbound 提示，模型可 prepare_source 重试。
      }
    }
    // 对照端跨轮恢复：上一轮已绑定过对照快照时直接挂回 compare 槽位（快照目录有缓存）。
    if (conversation.compare_source?.workspace_path) {
      try {
        await sourceHolder.bind(conversation.compare_source.workspace_path, 'compare');
      } catch {
        // 对照端恢复失败不阻断本轮；模型需要时会经 prepare_source 重新绑定。
      }
    }

    // knowledge/learner 由能力会话挂载；repository 不经直连（workspacePath 传 null），
    // 统一走懒代理工具组，由 prepare_source 轮内热绑定。
    capabilitySession = await createRoundCapabilitySession(capabilities, {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      runId,
      workspacePath: null,
      abortSignal,
      // 本轮开始时刻：log-mcp 据此把本轮日志实时写进独立文件（秒级粒度）。
      roundStartedAtMs: Date.parse(assistantMessage.created_at) || Date.now(),
    });

    const capabilityContext: CapabilityContext = {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      runId,
      workspacePath: conversation.workspace_path ?? null,
      abortSignal,
    };
    const roundTools: Record<string, unknown> = {};
    if (options.createConversationSource) {
      roundTools.prepare_source = createPrepareSourceTool({
        conversation,
        bind: options.createConversationSource,
        holder: sourceHolder,
        content,
        abortSignal,
      });
    }
    if (options.slotRegistry && options.compassAvailable) {
      // 知音楼渠道强制「先行结论 + 后台协查」：不挂同步 consult_compass，
      // 模型只能走 request_compass_followup，避免支持老师干等远端数分钟。
      if (conversation.channel !== 'yach_im') {
        roundTools.consult_compass = createConsultCompassTool({
          conversation,
          messageId: assistantMessage.id,
          runId,
          registry: options.slotRegistry,
          capabilityContext,
          saveConversation,
          content,
          maxCalls: budget.maxRemoteCalls,
        });
      }
      roundTools.request_compass_followup = createRequestCompassFollowupTool({
        conversation,
        messageId: assistantMessage.id,
        runId,
        registry: options.slotRegistry,
        capabilityContext,
        saveConversation,
        content,
        followupState,
      });
    }

    const toolsets = {
      ...capabilitySession.toolsets,
      ...createLazySourceToolset(sourceHolder),
      ...(Object.keys(roundTools).length > 0 ? { round: roundTools } : {}),
    } as unknown as ToolsetsInput;

    for await (const event of diagnosisAgent.stream({
      conversation,
      content,
      toolsets,
      abortSignal,
      softDeadlineAt,
      messageId: assistantMessage.id,
    })) {
      if (event.type === 'text') {
        const delta = streamRedactor.push(event.delta);
        text += delta;
        if (delta) await onEvent?.({ ...event, delta });
        continue;
      }
      const trailing = streamRedactor.flush();
      if (trailing) {
        text += trailing;
        await onEvent?.({ type: 'text', delta: trailing });
      }
      if (event.type === 'tool-start') {
        const safeEvent = redactRecord(event.event, redact);
        assistantMessage.steps.push(safeEvent);
        conversation.updated_at = new Date().toISOString();
        await saveConversation(conversation);
      } else if (event.type === 'tool-end') {
        const safeEvent = redactRecord(event.event, redact);
        assistantMessage.steps = assistantMessage.steps.map((step) => (step.id === safeEvent.id ? safeEvent : step));
        conversation.evidence_state = redactRecord(event.evidence_state, redact);
        conversation.updated_at = new Date().toISOString();
        await saveConversation(conversation);
      } else if (event.type === 'completed' && !terminal) {
        assistantMessage.content = redact(event.text);
        assistantMessage.status = 'completed';
        assistantMessage.report = null;
        assistantMessage.input_tokens = event.input_tokens;
        assistantMessage.output_tokens = event.output_tokens;
        assistantMessage.tool_usage = event.tool_usage;
        conversation.evidence_state = redactRecord(event.evidence_state, redact);
        conversation.messages_state = redactRecord(event.messages_state as Array<Record<string, unknown>>, redact);
        conversation.updated_at = new Date().toISOString();
        await persistTerminalConversation(saveConversation, conversation);
        terminalPersisted = true;
        // verdict 由最终答案的「判定：」锚点解析而来（agent 内已完成校验）。
        await recordTerminalCase(options, conversation, assistantMessage.id, event.verdict ?? null, 'completed', redact);
        terminal = 'completed';
        text = assistantMessage.content;
      } else if (event.type === 'failed' && !terminal) {
        const interrupted = Boolean(abortSignal.aborted);
        const failureCategory = interrupted ? 'cancelled' : event.failure_category;
        assistantMessage.content = redact(text);
        assistantMessage.status = 'failed';
        assistantMessage.error = interrupted ? '回复中断：请求已取消' : redact(event.error);
        assistantMessage.report = null;
        assistantMessage.tool_usage = { ...event.tool_usage, failure_category: failureCategory };
        assistantMessage.input_tokens = event.input_tokens;
        assistantMessage.output_tokens = event.output_tokens;
        assistantMessage.steps = assistantMessage.steps.map((step) => (step.status === 'running'
          ? { ...step, status: 'failed' as const, summary: '工具调用中断，结果未知' }
          : step));
        conversation.evidence_state = redactRecord(event.evidence_state, redact);
        conversation.updated_at = new Date().toISOString();
        await persistTerminalConversation(saveConversation, conversation);
        terminalPersisted = true;
        await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed', redact);
        terminal = 'failed';
      }
      await onEvent?.(redactRecord(event, redact));
    }
    if (!terminal) throw new Error('诊断流在终态事件前结束');
  } catch (error) {
    if (!terminal) {
      const interrupted = Boolean(abortSignal.aborted);
      const failureCategory = interrupted ? 'cancelled' : 'runtime_error';
      assistantMessage.content = redact(text);
      assistantMessage.status = 'failed';
      assistantMessage.error = interrupted
        ? '回复中断：请求已取消'
        : redact(error instanceof Error ? error.message : '诊断运行失败');
      assistantMessage.report = null;
      assistantMessage.tool_usage = { ...assistantMessage.tool_usage, failure_category: failureCategory };
      assistantMessage.steps = assistantMessage.steps.map((step) => (step.status === 'running'
        ? { ...step, status: 'failed' as const, summary: '工具调用中断，结果未知' }
        : step));
      conversation.updated_at = new Date().toISOString();
      try {
        await persistTerminalConversation(saveConversation, conversation);
        terminalPersisted = true;
        await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed', redact);
      } catch {
        console.error('Conversation terminal state persistence failed; restart recovery is required');
      }
      terminal = 'failed';
    }
  } finally {
    await capabilitySession?.close().catch(() => undefined);
    await sourceHolder?.close().catch(() => undefined);
  }

  // 后台协查：轮次终态后才开始等远端，不占用用户等待；结果以新消息追加。
  scheduleCompassFollowupSettle({
    store: input.store,
    redact,
    conversationId: conversation.id,
    followupState,
    options,
    analyzeFollowup: async ({ conversation: latest, outcome }) => {
      // 兜底绑源码：分析轮的性命不该捏在主轮手里——主轮没走 prepare_source 时，
      // 按会话已有上下文（端/版本/历史消息）补绑，让协查结论永远能映射回客户端代码。
      // 绑定结果随 settle 末尾的 saveConversation 一并落库。
      if (!latest.workspace_path && options.createConversationSource) {
        const lastUser = [...latest.messages].reverse().find((message) => message.role === 'user');
        await prepareConversationSource(
          latest,
          lastUser?.content ?? '',
          options.createConversationSource,
        ).catch(() => undefined);
        if (latest.workspace_path) {
          emitFollowupEvent(latest.id, latest.created_at, {
            kind: 'followup_source_bound',
            title: '分析前自动绑定源码快照（主轮未绑定，settle 兜底）',
            data: {
              platform: latest.platform,
              version: latest.version,
              repositories: (latest.source_repositories ?? []).map((repository) => repository.repository_id),
            },
          });
        }
      }
      const analysis = await analyzeFollowupWithSource({
        modelConfiguration: input.modelConfiguration,
        capabilities: input.capabilities,
        conversation: latest,
        outcome,
        mastra: input.diagnosisAgent.tracingMastra,
        onSkip: (reason) =>
          emitFollowupEvent(latest.id, latest.created_at, {
            kind: 'followup_analysis_skipped',
            title: '客户端侧源码分析未执行',
            data: { reason },
          }),
      });
      if (analysis) {
        emitFollowupEvent(latest.id, latest.created_at, {
          kind: 'followup_analysis_completed',
          title: '客户端侧源码分析完成',
          detail: analysis.text,
          data: { input_tokens: analysis.inputTokens, output_tokens: analysis.outputTokens },
        });
      }
      return analysis;
    },
    synthesizeYachReply: async ({ conversation: latest, outcome, analysis }) => {
      const synthesis = await synthesizeYachFollowupReply({
        modelConfiguration: input.modelConfiguration,
        conversation: latest,
        outcome,
        analysis,
        mastra: input.diagnosisAgent.tracingMastra,
        onSkip: (reason) =>
          emitFollowupEvent(latest.id, latest.created_at, {
            kind: 'followup_synthesis_fallback',
            title: '知音楼综合答复未生成，回退拼装文案',
            data: { reason },
          }),
      });
      if (synthesis) {
        emitFollowupEvent(latest.id, latest.created_at, {
          kind: 'followup_synthesis_completed',
          title: '知音楼综合答复生成完成',
          data: { chars: synthesis.text.length, input_tokens: synthesis.inputTokens, output_tokens: synthesis.outputTokens },
        });
      }
      return synthesis;
    },
  });

  return {
    conversation,
    assistantMessage,
    runId,
    terminal,
    terminalPersisted,
    text: assistantMessage.content || text,
    compassFollowupPending: followupState.handle !== null,
  };
}
