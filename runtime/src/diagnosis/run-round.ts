import { randomUUID } from 'node:crypto';

import type {
  ChatMessage,
  ConversationRecord,
  DiagnosisReport,
  RemoteConclusion,
} from '../domain/schemas.js';
import type { CapabilityMcp } from '../capabilities/mcp.js';
import type { LogToolCorrelation } from '../capabilities/log-center.js';
import { createRoundCapabilitySession, type CapabilitySession } from '../capabilities/session.js';
import type { ModelConfiguration } from '../model/configuration.js';
import type { ProductStore } from '../product/store.js';
import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../security/redaction.js';
import { appendDiagnosisOutcome, archiveDiagnosisCase } from '../observability/cases.js';
import { DiagnosisAgent, type DiagnosisStreamEvent } from './agent.js';
import {
  createInvestigationPlan,
  type InvestigationBudget,
  type InvestigationPlan,
  type RequestedInvestigationScope,
  type CorrelationContext,
} from '../orchestration/plan.js';
import type { ServerSignals } from '../orchestration/server-signals.js';
import { extractCorrelationContext } from '../orchestration/correlation.js';
import { extractClientIdentityFromMessages } from '../orchestration/client-identity.js';
import { clientIdentifiersFromMessages, redactClientText, createClientLogPrivacy } from '../security/client-context.js';
import { createStreamRedactor } from '../security/stream-redaction.js';
import { decideLocalContinuation } from '../orchestration/loop.js';
import {
  RuntimeSupervisor,
  type Branch,
  type BranchResult,
  type BranchStatus,
  type SupervisorRunResult,
} from '../orchestration/supervisor.js';
import type { AgentSlotRegistry } from '../orchestration/agent-slot-registry.js';
import {
  CompassServerBranch,
  type CompassServerBranchData,
} from '../orchestration/server-branch.js';
import {
  approveExternalConsultation,
  createExternalConsultation,
  rejectExternalConsultation,
  expireExternalConsultation,
  type ExternalConsultation,
} from '../orchestration/consultation.js';
import {
  appendPlanHistory,
  createInvestigationStateSnapshot,
  readInvestigationStateSnapshot,
  serializeInvestigationState,
  type InvestigationStateSnapshot,
} from '../orchestration/investigation-state.js';

const DEFAULT_INVESTIGATION_BUDGET: InvestigationBudget = { maxSeconds: 900, maxRemoteCalls: 4 };
const EMPTY_SERVER_SIGNALS: ServerSignals = {
  version: 1,
  serviceNames: [],
  apiPrefixes: [],
  errorCodePatterns: [],
};
const REMOTE_REJECTED_SUFFIX = '\n\n未获外部协查批准，本次仅保留现有调查结果和证据缺口。';
const REMOTE_EXPIRED_SUFFIX = '\n\n外部协查确认已过期，本次仅保留现有调查结果和证据缺口。';

/** 原始标识只进入本轮私有工具上下文，不进入模型 schema、计划或持久化记录。 */
export function buildRoundLogCorrelation(
  conversation: ConversationRecord,
  content: string,
): LogToolCorrelation {
  const userTexts = conversation.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .slice(-20);
  if (userTexts.at(-1) !== content) userTexts.push(content);
  const identity = extractClientIdentityFromMessages(userTexts);
  return {
    sourceText: userTexts.join('\n').slice(0, 100_000),
    identifiers: clientIdentifiersFromMessages(userTexts),
    ...(identity.learnerIdSource ? { learnerIdSource: identity.learnerIdSource } : {}),
  };
}

type CompletedEvent = Extract<DiagnosisStreamEvent, { type: 'completed' }>;
type FailedEvent = Extract<DiagnosisStreamEvent, { type: 'failed' }>;

export type OrchestrationEvent =
  | { type: 'INVESTIGATION_PLAN'; runId: string; plan: InvestigationPlan; resumed: boolean }
  | { type: 'BRANCH_STATUS'; runId: string; branch: 'client' | 'server'; status: BranchStatus | 'running' }
  | {
      type: 'EXTERNAL_CONSULTATION_REQUIRED';
      runId: string;
      plan: InvestigationPlan;
      consultation: ExternalConsultation;
    }
  | {
      type: 'JOINT_ASSESSMENT';
      runId: string;
      responsibility: DiagnosisReport['responsibility'];
      assessment: DiagnosisReport['joint_assessment'];
    };

export interface RunDiagnosisRoundOptions {
  knowledgeQueryLog?: string;
  caseArchiveDir?: string;
  serverSignals?: ServerSignals;
  slotRegistry?: AgentSlotRegistry;
  compassAvailable?: boolean;
  investigationBudget?: InvestigationBudget;
}

export type ConsultationResumeDecision = 'approved' | 'rejected' | 'expired';

export interface RunDiagnosisRoundInput {
  store: ProductStore;
  diagnosisAgent: DiagnosisAgent;
  capabilities: CapabilityMcp;
  modelConfiguration: ModelConfiguration;
  conversation: ConversationRecord;
  content: string;
  runId?: string;
  abortSignal?: AbortSignal;
  resume?: { consultationId: string; decision: ConsultationResumeDecision };
  onPrepared?: (info: {
    conversation: ConversationRecord;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    runId: string;
  }) => void | Promise<void>;
  onEvent?: (event: DiagnosisStreamEvent) => void | Promise<void>;
  onOrchestrationEvent?: (event: OrchestrationEvent) => void | Promise<void>;
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
  terminal: 'completed' | 'failed' | 'waiting_confirmation';
  terminalPersisted: boolean;
  text: string;
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

function newAssistantMessage(): ChatMessage {
  return {
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
  conversation: ConversationRecord,
  content: string,
): (text: string) => string {
  const base = (text: string) => modelConfiguration.redact?.(text) ?? redactSensitiveText(text);
  const userTexts = conversation.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  if (userTexts.at(-1) !== content) userTexts.push(content);
  const privacy = createClientLogPrivacy(userTexts, false);
  return Object.assign(
    (text: string) => redactClientText(privacy, base(text)),
    { sensitiveSuffixLength: (text: string) => privacy.sensitiveSuffixLength(text) },
  );
}

/** Persist admission before Web sends HTTP 200 or starts any capability clients. */
export async function prepareDiagnosisRound(
  input: Pick<RunDiagnosisRoundInput, 'store' | 'modelConfiguration' | 'content' | 'conversation' | 'runId' | 'resume'>,
): Promise<PreparedDiagnosisRound> {
  const { store, modelConfiguration } = input;
  const redact = roundRedactor(modelConfiguration, input.conversation, input.content);
  const saveConversation = async (conversation: ConversationRecord) => {
    await store.saveConversation(redactConversationForPersistence(conversation, redact));
  };
  const conversation = input.conversation;
  const runId = input.runId ?? `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  if (input.resume) {
    if (conversation.run_state !== 'waiting_confirmation') {
      throw new Error('只有等待确认的会话可以恢复');
    }
    const state = readInvestigationStateSnapshot(conversation.investigation);
    if (state.consultationId !== input.resume.consultationId) {
      throw new Error('咨询记录不属于当前等待中的调查');
    }
    const index = conversation.consultations.findIndex((item) => item.id === input.resume?.consultationId);
    const consultation = conversation.consultations[index];
    if (!consultation || consultation.conversation_id !== conversation.id || consultation.status !== 'pending') {
      throw new Error('咨询记录不属于该会话或不在待确认状态');
    }
    const userMessage = conversation.messages.find((message) =>
      message.id === state.userMessageId && message.role === 'user');
    if (!userMessage) throw new Error('调查状态引用的原始用户消息不存在');
    const decisionInput = { conversationId: conversation.id, runId: consultation.run_id };
    const decided = input.resume.decision === 'approved'
      ? approveExternalConsultation(consultation, decisionInput)
      : input.resume.decision === 'rejected'
        ? rejectExternalConsultation(consultation, decisionInput)
        : expireExternalConsultation(consultation, decisionInput);
    const assistantMessage = newAssistantMessage();

    // 咨询决定、run_state 和新占位必须在同一个整记录写入中提交。
    conversation.consultations[index] = decided;
    conversation.messages.push(assistantMessage);
    conversation.run_state = 'running';
    conversation.updated_at = new Date().toISOString();
    await saveConversation(conversation);
    return { conversation, userMessage, assistantMessage, runId };
  }

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

/** Shared diagnosis round used by web SSE and Yach IM; no HTTP/SSE encoding here. */
export async function runDiagnosisRound(input: RunDiagnosisRoundInput): Promise<RunDiagnosisRoundResult> {
  const prepared = input.prepared ?? await prepareDiagnosisRound(input);
  const orchestrated = Boolean(
    input.resume || input.options?.serverSignals ||
    input.options?.slotRegistry || input.options?.compassAvailable !== undefined ||
    input.options?.investigationBudget,
  );
  return orchestrated
    ? runOrchestratedDiagnosisRound(input, prepared)
    : runLegacyDiagnosisRound(input, prepared);
}

async function runLegacyDiagnosisRound(
  input: RunDiagnosisRoundInput,
  prepared: PreparedDiagnosisRound,
): Promise<RunDiagnosisRoundResult> {
  const { store, diagnosisAgent, capabilities, modelConfiguration, abortSignal, onPrepared, onEvent, options = {} } = input;
  const redact = roundRedactor(modelConfiguration, input.conversation, input.content);
  const streamRedactor = createStreamRedactor(redact);
  const saveConversation = async (conversation: ConversationRecord) => {
    await store.saveConversation(redactConversationForPersistence(conversation, redact));
  };
  const { conversation, userMessage, assistantMessage, runId } = prepared;
  const content = userMessage.content;
  await onPrepared?.({ conversation, userMessage, assistantMessage, runId });
  let text = '';
  let capabilitySession: CapabilitySession | undefined;
  let terminal: 'completed' | 'failed' | null = null;
  let terminalPersisted = false;

  try {
    capabilitySession = await createRoundCapabilitySession(capabilities, {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      runId,
      workspacePath: conversation.workspace_path,
      repositoryId: conversation.repository_id ?? null,
      resolvedCommit: conversation.resolved_commit ?? null,
      logCorrelation: buildRoundLogCorrelation(conversation, content),
      abortSignal,
    });

    for await (const event of diagnosisAgent.stream({
      conversation,
      content,
      toolsets: capabilitySession.toolsets,
      abortSignal,
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
        assistantMessage.report = redactRecord(event.report, redact);
        assistantMessage.input_tokens = event.input_tokens;
        assistantMessage.output_tokens = event.output_tokens;
        assistantMessage.tool_usage = event.tool_usage;
        conversation.evidence_state = redactRecord(event.evidence_state, redact);
        conversation.messages_state = redactRecord(event.messages_state as Array<Record<string, unknown>>, redact);
        conversation.updated_at = new Date().toISOString();
        await persistTerminalConversation(saveConversation, conversation);
        terminalPersisted = true;
        await recordTerminalCase(options, conversation, assistantMessage.id, event.report?.verdict ?? null, 'completed', redact);
        terminal = 'completed';
        text = assistantMessage.content;
      } else if (event.type === 'failed' && !terminal) {
        const interrupted = Boolean(abortSignal?.aborted);
        const failureCategory = interrupted ? 'cancelled' : event.failure_category;
        assistantMessage.content = redact(text);
        assistantMessage.status = 'failed';
        assistantMessage.error = interrupted ? '回复中断：请求已取消' : redact(event.error);
        assistantMessage.report = null;
        assistantMessage.tool_usage = { ...event.tool_usage, failure_category: failureCategory };
        assistantMessage.input_tokens = event.input_tokens;
        assistantMessage.output_tokens = event.output_tokens;
        assistantMessage.steps = assistantMessage.steps.map((step) => (step.status === 'running'
          ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
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
      const interrupted = Boolean(abortSignal?.aborted);
      const failureCategory = interrupted ? 'cancelled' : 'runtime_error';
      assistantMessage.content = redact(text);
      assistantMessage.status = 'failed';
      assistantMessage.error = interrupted
        ? '回复中断：请求已取消'
        : redact(error instanceof Error ? error.message : '诊断运行失败');
      assistantMessage.report = null;
      assistantMessage.tool_usage = { ...assistantMessage.tool_usage, failure_category: failureCategory };
      assistantMessage.steps = assistantMessage.steps.map((step) => (step.status === 'running'
        ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
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
  }

  return {
    conversation,
    assistantMessage,
    runId,
    terminal,
    terminalPersisted,
    text: assistantMessage.content || text,
  };
}

async function runOrchestratedDiagnosisRound(
  input: RunDiagnosisRoundInput,
  prepared: PreparedDiagnosisRound,
): Promise<RunDiagnosisRoundResult> {
  const {
    store, diagnosisAgent, capabilities, modelConfiguration, abortSignal,
    onPrepared, onEvent, onOrchestrationEvent, options = {},
  } = input;
  const redact = roundRedactor(modelConfiguration, input.conversation, input.content);
  let saveTail: Promise<void> = Promise.resolve();
  const saveConversation = (value: ConversationRecord): Promise<void> => {
    const pending = saveTail.then(async () => {
      await store.saveConversation(redactConversationForPersistence(value, redact));
    });
    saveTail = pending.catch(() => undefined);
    return pending;
  };
  const { conversation, userMessage, assistantMessage, runId } = prepared;
  const content = userMessage.content;
  await onPrepared?.({ conversation, userMessage, assistantMessage, runId });

  let state: InvestigationStateSnapshot | undefined;
  let capabilitySession: CapabilitySession | undefined;
  let terminal: RunDiagnosisRoundResult['terminal'] | null = null;
  let terminalPersisted = false;
  let text = '';
  let streamedText = '';
  let localCompleted: CompletedEvent | undefined;
  let localFailed: FailedEvent | undefined;

  const emit = async (event: OrchestrationEvent) => {
    await onOrchestrationEvent?.(redactRecord(event, redact));
  };
  const persistInvestigation = () => {
    if (state) conversation.investigation = serializeInvestigationState(state);
  };
  const complete = async (event: CompletedEvent, suffix = '') => {
    if (terminal) return;
    assistantMessage.content = `${redact(event.text)}${suffix}`;
    assistantMessage.status = 'completed';
    assistantMessage.error = null;
    assistantMessage.report = redactRecord(event.report, redact);
    assistantMessage.input_tokens = event.input_tokens;
    assistantMessage.output_tokens = event.output_tokens;
    assistantMessage.tool_usage = event.tool_usage;
    conversation.evidence_state = redactRecord(event.evidence_state, redact);
    conversation.messages_state = redactRecord(event.messages_state as Array<Record<string, unknown>>, redact);
    conversation.run_state = 'completed';
    persistInvestigation();
    conversation.updated_at = new Date().toISOString();
    await persistTerminalConversation(saveConversation, conversation);
    terminalPersisted = true;
    await recordTerminalCase(options, conversation, assistantMessage.id, event.report?.verdict ?? null, 'completed', redact);
    terminal = 'completed';
    text = assistantMessage.content;
  };
  const fail = async (input: {
    error: string;
    category: string;
    evidenceState?: Record<string, unknown>;
    inputTokens?: number | null;
    outputTokens?: number | null;
    toolUsage?: Record<string, number | string>;
  }) => {
    if (terminal) return;
    const interrupted = input.category === 'cancelled' || Boolean(abortSignal?.aborted);
    const failureCategory = interrupted ? 'cancelled' : input.category;
    assistantMessage.content = redact(streamedText || assistantMessage.content);
    assistantMessage.status = 'failed';
    assistantMessage.error = interrupted ? '回复中断：请求已取消' : redact(input.error);
    assistantMessage.report = null;
    assistantMessage.tool_usage = { ...(input.toolUsage ?? assistantMessage.tool_usage), failure_category: failureCategory };
    assistantMessage.input_tokens = input.inputTokens === undefined ? assistantMessage.input_tokens : input.inputTokens;
    assistantMessage.output_tokens = input.outputTokens === undefined ? assistantMessage.output_tokens : input.outputTokens;
    assistantMessage.steps = assistantMessage.steps.map((step) => (step.status === 'running'
      ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
      : step));
    if (input.evidenceState) conversation.evidence_state = redactRecord(input.evidenceState, redact);
    conversation.run_state = interrupted ? 'cancelled' : 'failed';
    persistInvestigation();
    conversation.updated_at = new Date().toISOString();
    await persistTerminalConversation(saveConversation, conversation);
    terminalPersisted = true;
    await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed', redact);
    terminal = 'failed';
  };
  const failEvent = async (event: FailedEvent) => fail({
    error: event.error,
    category: abortSignal?.aborted ? 'cancelled' : event.failure_category,
    evidenceState: event.evidence_state,
    inputTokens: event.input_tokens,
    outputTokens: event.output_tokens,
    toolUsage: event.tool_usage,
  });
  const completeRejectedLocal = async (suffix: string) => {
    if (!state?.localReport || terminal) return;
    assistantMessage.content = `${redact(state.localText || state.localReport.summary)}${suffix}`;
    assistantMessage.status = 'completed';
    assistantMessage.error = null;
    assistantMessage.report = redactRecord(state.localReport, redact);
    conversation.run_state = 'completed';
    conversation.messages_state = redactRecord([
      ...conversation.messages_state,
      { role: 'assistant', content: assistantMessage.content },
    ], redact);
    persistInvestigation();
    conversation.updated_at = new Date().toISOString();
    await persistTerminalConversation(saveConversation, conversation);
    terminalPersisted = true;
    await recordTerminalCase(options, conversation, assistantMessage.id, state.localReport.verdict, 'completed', redact);
    terminal = 'completed';
    text = assistantMessage.content;
  };

  const consumeAgentStream = async (
    phase: 'local' | 'joint',
    final: boolean,
    signal: AbortSignal | undefined,
    toolsets: CapabilitySession['toolsets'],
    completionSuffix = '',
    clientSteps: InvestigationPlan['clientSteps'] = [],
  ): Promise<BranchResult> => {
    streamedText = '';
    const streamRedactor = createStreamRedactor(redact);
    if (phase === 'local') {
      localCompleted = undefined;
      localFailed = undefined;
    }
    let completedEvent: CompletedEvent | undefined;
    let failedEvent: FailedEvent | undefined;
    for await (const event of diagnosisAgent.stream({
      conversation,
      content,
      toolsets,
      abortSignal: signal,
      phase,
      clientSteps: phase === 'local' ? clientSteps : [],
      localReport: phase === 'joint' ? state?.localReport ?? null : undefined,
      externalFindings: phase === 'joint' ? conversation.external_findings : undefined,
      messageId: assistantMessage.id,
    })) {
      if (event.type === 'text') {
        const delta = streamRedactor.push(event.delta);
        streamedText += delta;
        if (delta) await onEvent?.({ ...event, delta });
        continue;
      }
      const trailing = streamRedactor.flush();
      if (trailing) {
        streamedText += trailing;
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
      } else if (event.type === 'completed') {
        completedEvent = event;
        if (final) {
          await complete(event, completionSuffix);
        } else {
          localCompleted = event;
          if (state) {
            state.localReport = event.report;
            state.localText = event.text;
          }
          assistantMessage.content = redact(event.text);
          assistantMessage.error = null;
          assistantMessage.report = null;
          assistantMessage.input_tokens = event.input_tokens;
          assistantMessage.output_tokens = event.output_tokens;
          assistantMessage.tool_usage = event.tool_usage;
          conversation.evidence_state = redactRecord(event.evidence_state, redact);
          conversation.messages_state = redactRecord(event.messages_state as Array<Record<string, unknown>>, redact);
          persistInvestigation();
          conversation.updated_at = new Date().toISOString();
          await saveConversation(conversation);
        }
      } else if (event.type === 'failed') {
        failedEvent = event;
        if (final) {
          await failEvent(event);
        } else {
          localFailed = event;
          assistantMessage.content = redact(streamedText);
          assistantMessage.input_tokens = event.input_tokens;
          assistantMessage.output_tokens = event.output_tokens;
          assistantMessage.tool_usage = event.tool_usage;
          assistantMessage.steps = assistantMessage.steps.map((step) => (step.status === 'running'
            ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
            : step));
          conversation.evidence_state = redactRecord(event.evidence_state, redact);
          conversation.updated_at = new Date().toISOString();
          await saveConversation(conversation);
        }
      }
      await onEvent?.(redactRecord(event, redact));
      if (final && phase === 'joint' && event.type === 'completed') {
        await emit({
          type: 'JOINT_ASSESSMENT',
          runId,
          responsibility: event.report?.responsibility ?? 'unknown',
          assessment: event.report?.joint_assessment ?? null,
        });
      }
    }
    if (!completedEvent && !failedEvent) throw new Error('诊断流在终态事件前结束');
    if (final) {
      if (!terminal) throw new Error('诊断终态未被持久化');
      return { branch: 'client', status: terminal === 'completed' ? 'completed' : 'failed' };
    }
    if (completedEvent) {
      const report = completedEvent.report;
      return {
        branch: 'client',
        status: 'completed',
        responsibility: report?.responsibility ?? 'unknown',
        taskType: report?.task_type ?? 'unknown',
        nextAction: externalInvestigationQuestion(report),
        hasObservedEvidence: Boolean(report?.evidence.some((item) => item.kind === 'source' || item.kind === 'log')),
        data: completedEvent,
      };
    }
    return {
      branch: 'client',
      status: signal?.aborted ? 'cancelled' : 'failed',
      error: failedEvent?.error ?? '本地诊断失败',
      data: failedEvent,
    };
  };

  const observedBranch = (branch: 'client' | 'server', delegate: Branch): Branch => ({
    async run(plan, context) {
      await emit({ type: 'BRANCH_STATUS', runId, branch, status: 'running' });
      return delegate.run(plan, context);
    },
    cancel: (reason) => delegate.cancel(reason),
  });

  const clientBranch = observedBranch('client', {
    run: (plan, context) => consumeAgentStream('local', false, context.abortSignal, capabilitySession!.toolsets, '', plan.clientSteps),
    cancel: async () => undefined,
  });

  const executeSupervisor = async (plan: InvestigationPlan, allowRemote: boolean): Promise<SupervisorRunResult> => {
    if (!state || !capabilitySession) throw new Error('执行分支前缺少调查状态或能力会话');
    const consultation = conversation.consultations.find((item) => item.id === state?.consultationId);
    let serverBranch: Branch;
    if (allowRemote && consultation?.status === 'approved' && options.slotRegistry) {
      serverBranch = new CompassServerBranch(options.slotRegistry, {
        consultation,
        onConsultationUpdate: async (updated) => {
          upsertConsultation(conversation, updated);
          conversation.updated_at = new Date().toISOString();
          await saveConversation(conversation);
        },
        onAudit: async (audit) => {
          conversation.slot_audit.push(redactRecord(audit, redact));
          conversation.updated_at = new Date().toISOString();
          await saveConversation(conversation);
        },
      });
    } else {
      serverBranch = {
        run: async () => ({
          branch: 'server',
          status: allowRemote ? 'failed' : 'skipped',
          error: allowRemote ? '已批准的外部协查不可用' : '外部协查未获批准',
        }),
        cancel: async () => undefined,
      };
    }
    const result = await new RuntimeSupervisor().run({
      plan,
      branches: {
        client: clientBranch,
        server: observedBranch('server', serverBranch),
      },
      context: {
        abortSignal,
        // 本地接续由轮次层先建立固定摘要的自动授权记录，再执行远端与联合阶段。
        compassEnabled: allowRemote,
        capabilityContext: {
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          runId,
          workspacePath: conversation.workspace_path ?? null,
          repositoryId: conversation.repository_id ?? null,
          resolvedCommit: conversation.resolved_commit ?? null,
        },
      },
      approveRemote: async () => {
        if (!allowRemote || consultation?.status !== 'approved') return false;
        if (state!.remoteCallsUsed >= plan.budget.maxRemoteCalls) return false;
        state!.remoteCallsUsed += 1;
        persistInvestigation();
        await saveConversation(conversation);
        return true;
      },
      onBranchStatus: async (branch, status) => {
        await emit({ type: 'BRANCH_STATUS', runId, branch, status });
      },
    });
    for (const item of result.planHistory) appendPlanHistory(state, item);
    for (const branchResult of result.results) {
      if (branchResult.branch !== 'server' || !branchResult.data) continue;
      const data = branchResult.data as CompassServerBranchData;
      if (data.consultation) upsertConsultation(conversation, data.consultation);
      if (data.remoteConclusion) upsertExternalFinding(conversation, data.remoteConclusion);
    }
    persistInvestigation();
    conversation.updated_at = new Date().toISOString();
    await saveConversation(conversation);
    return result;
  };

  const finishCancelledOrFailed = async (result: SupervisorRunResult) => {
    if (localFailed) {
      await failEvent(localFailed);
    } else {
      await fail({
        error: result.status === 'cancelled' ? '调查已取消或调查预算已到期' : '调查分支未能形成有效结果',
        category: result.status === 'cancelled' ? 'cancelled' : 'runtime_error',
      });
    }
  };

  const runExternalAndJoint = async (currentPlan: InvestigationPlan, correlation: CorrelationContext) => {
    if (!state || !capabilitySession) throw new Error('外部协查前缺少调查状态或能力会话');
    const consultation = createAutomaticConsultation(
      conversation, assistantMessage.id, runId, currentPlan, content, correlation, state.localReport ?? null,
    );
    state.consultationId = consultation.id;
    upsertConsultation(conversation, consultation);
    persistInvestigation();
    conversation.updated_at = new Date().toISOString();
    await saveConversation(conversation);
    const result = await executeSupervisor(currentPlan, true);
    if (result.status === 'cancelled') await finishCancelledOrFailed(result);
    else await consumeAgentStream('joint', true, abortSignal, capabilitySession.toolsets);
  };

  try {
    let plan: InvestigationPlan;
    let correlation: CorrelationContext;
    if (input.resume) {
      state = readInvestigationStateSnapshot(conversation.investigation);
      plan = state.currentPlan;
      correlation = extractCorrelationContext(state.originalContent);
      if (state.consultationId !== input.resume.consultationId) throw new Error('恢复咨询与调查状态不匹配');
      await emit({ type: 'INVESTIGATION_PLAN', runId, plan, resumed: true });
    } else {
      correlation = extractCorrelationContext(content);
      const requestedScope = requestedScopeFor(content);
      const compassAvailable = options.compassAvailable === true && Boolean(options.slotRegistry);
      const compassEnabled = compassAvailable;
      plan = createInvestigationPlan({
        question: content,
        repositoryBound: Boolean(conversation.workspace_path),
        hasLocalEvidence: hasLocalEvidence(conversation),
        hasLogObservation: hasLogObservation(conversation),
        requestedScope,
        compassEnabled,
        correlation,
        budget: options.investigationBudget ?? DEFAULT_INVESTIGATION_BUDGET,
      }, options.serverSignals ?? EMPTY_SERVER_SIGNALS);
      state = createInvestigationStateSnapshot({ originalContent: content, userMessageId: userMessage.id, plan });
      conversation.run_state = 'running';
      persistInvestigation();
      await emit({ type: 'INVESTIGATION_PLAN', runId, plan, resumed: false });

      conversation.updated_at = new Date().toISOString();
      await saveConversation(conversation);
    }

    const remoteUnavailableSuffix = input.resume?.decision === 'expired'
      ? REMOTE_EXPIRED_SUFFIX
      : REMOTE_REJECTED_SUFFIX;

    // 已保留本地报告的拒绝/过期路径不需要重跑模型或挂载任何分支能力。
    if (input.resume && input.resume.decision !== 'approved' && state.localReport) {
      await completeRejectedLocal(remoteUnavailableSuffix);
      return roundResult(conversation, assistantMessage, runId, terminal, terminalPersisted, text);
    }

    capabilitySession = await createRoundCapabilitySession(capabilities, {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      runId,
      workspacePath: conversation.workspace_path,
      repositoryId: conversation.repository_id ?? null,
      resolvedCommit: conversation.resolved_commit ?? null,
      logCorrelation: buildRoundLogCorrelation(conversation, content),
      abortSignal,
    });

    if (!input.resume) {
      if (plan.mode !== 'local') {
        await runExternalAndJoint(plan, correlation);
      } else {
        const result = await executeSupervisor(plan, false);
        if (result.status === 'cancelled') {
          await finishCancelledOrFailed(result);
        } else if (localCompleted) {
          const report = localCompleted.report;
          const decision = decideLocalContinuation(plan, {
            responsibility: report?.responsibility ?? 'unknown',
            taskType: report?.task_type ?? 'unknown',
            nextAction: externalInvestigationQuestion(report),
            hasObservedEvidence: Boolean(report?.evidence.some((item) => item.kind === 'source' || item.kind === 'log')),
            requestedScope: requestedScopeFor(content),
            compassEnabled: options.compassAvailable === true && Boolean(options.slotRegistry),
            correlationReady: plan.correlationReady,
            budgetExpired: false,
            remoteCallsExhausted: state.remoteCallsUsed >= plan.budget.maxRemoteCalls,
            handoffsExhausted: state.handoffRoundsUsed >= plan.maxHandoffRounds,
          });
          if (decision.type === 'continue_external') {
            state.handoffRoundsUsed += 1;
            state.currentPlan = decision.plan;
            appendPlanHistory(state, decision.plan);
            plan = decision.plan;
            await emit({ type: 'INVESTIGATION_PLAN', runId, plan, resumed: false });
            await runExternalAndJoint(plan, correlation);
          } else {
            await complete(localCompleted);
          }
        } else {
          await finishCancelledOrFailed(result);
        }
      }
    } else if (input.resume.decision !== 'approved') {
      if (state.initialPlan.mode === 'parallel') {
        plan = {
          ...state.currentPlan,
          mode: 'local',
          branches: ['client'],
          remoteSlots: [],
          reason: '外部协查被拒绝，仅执行尚未运行的本地分支',
        };
        state.currentPlan = plan;
        appendPlanHistory(state, plan);
        persistInvestigation();
        await emit({ type: 'INVESTIGATION_PLAN', runId, plan, resumed: true });
        conversation.updated_at = new Date().toISOString();
        await saveConversation(conversation);
        const result = await executeSupervisor(plan, false);
        if (localCompleted && result.status !== 'cancelled') await complete(localCompleted, remoteUnavailableSuffix);
        else await finishCancelledOrFailed(result);
      } else {
        // 纯 server 计划没有本地结果可回退；joint 阶段只生成缺口，不挂载本地工具。
        await consumeAgentStream('joint', true, abortSignal, {}, remoteUnavailableSuffix);
      }
    } else {
      const result = await executeSupervisor(plan, true);
      if (result.status === 'cancelled') await finishCancelledOrFailed(result);
      else await consumeAgentStream('joint', true, abortSignal, capabilitySession.toolsets);
    }
  } catch (error) {
    if (!terminal) {
      try {
        await fail({
          error: error instanceof Error ? error.message : '诊断运行失败',
          category: abortSignal?.aborted ? 'cancelled' : 'runtime_error',
        });
      } catch {
        console.error('Conversation terminal state persistence failed; restart recovery is required');
      }
      terminal = 'failed';
    }
  } finally {
    await capabilitySession?.close().catch(() => undefined);
  }

  return roundResult(conversation, assistantMessage, runId, terminal, terminalPersisted, text);
}

function externalInvestigationQuestion(report: DiagnosisReport | null | undefined): string | undefined {
  return report?.next_action?.target === 'external' || report?.next_action?.target === 'server'
    ? report.next_action.question
    : undefined;
}

// 外发内容限长：用户原文逐条/总量、证据条数/摘录长度，防止超长会话挤占外发预算。
const OUTBOUND_USER_MESSAGE_MAX = 2_000;
const OUTBOUND_USER_TOTAL_MAX = 8_000;
const OUTBOUND_EVIDENCE_MAX_ITEMS = 10;
const OUTBOUND_EVIDENCE_EXCERPT_MAX = 800;

function clipCodepoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…（截断）`;
}

function createAutomaticConsultation(
  conversation: ConversationRecord,
  messageId: string,
  runId: string,
  plan: InvestigationPlan,
  content: string,
  correlation: CorrelationContext,
  localReport: DiagnosisReport | null,
): ExternalConsultation {
  const correlationText = [
    correlation.traceId ? `traceId: ${correlation.traceId}` : null,
    correlation.requestId ? `requestId: ${correlation.requestId}` : null,
  ].filter((item): item is string => Boolean(item)).join('\n');
  // 缺 traceId/requestId 不再阻断外发，但必须在固定摘要里显式声明关联缺口，
  // 让外部 Agent 按学员标识与时间窗关联，而不是误以为 Runtime 漏传了请求级标识。
  const correlationSection = correlationText
    ? `关联信息：\n${correlationText}`
    : '关联信息：本次故障缺少 traceId/requestId，请按用户问题中的学员标识与时间窗关联核查。';

  // 外部 Agent 需要完整的问题描述：本会话全部用户消息原文（老师常分多条补充细节），逐条与总量限长。
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
  const sections = [
    `用户问题原文：\n${userLines.join('\n') || clipCodepoints(content, OUTBOUND_USER_MESSAGE_MAX)}`,
    correlationSection,
  ];

  // 本地排查的证据、判断和具体协查问题一并外发（含学员标识等观测事实；Compass 全链路内网，已确认不伪名化）。
  if (localReport) {
    const evidenceLines = localReport.evidence
      .slice(0, OUTBOUND_EVIDENCE_MAX_ITEMS)
      .map((item) =>
        `- [${item.kind}] ${item.location ?? 'unknown'}：${clipCodepoints(item.excerpt, OUTBOUND_EVIDENCE_EXCERPT_MAX)}\n  支持点：${clipCodepoints(item.supports, 200)}`);
    if (evidenceLines.length > 0) {
      const omitted = localReport.evidence.length - evidenceLines.length;
      sections.push(
        `本地调查证据（来自本次工具观测）：\n${evidenceLines.join('\n')}${omitted > 0 ? `\n…（另 ${omitted} 条证据未包含）` : ''}`,
      );
    }
    const judgment = [
      `结论摘要：${clipCodepoints(localReport.summary, 600)}`,
      `责任判断：${localReport.responsibility}（未经远端验证）`,
      localReport.likely_location ? `疑似位置：${localReport.likely_location}` : null,
      localReport.root_cause_candidates.length > 0
        ? `根因候选：${localReport.root_cause_candidates.map((item) => `${item.title}（置信度 ${item.confidence}）`).join('；')}`
        : null,
      localReport.missing_information.length > 0
        ? `仍缺信息：${localReport.missing_information.join('；')}`
        : null,
    ].filter((item): item is string => Boolean(item));
    sections.push(`本地判断（未经远端验证，供参考）：\n${judgment.join('\n')}`);
    const question = externalInvestigationQuestion(localReport);
    if (question) sections.push(`请协查的问题：\n${clipCodepoints(question, 1_000)}`);
  }

  const pending = createExternalConsultation({
    conversationId: conversation.id,
    messageId,
    runId,
    reason: plan.reason,
    outboundText: sections.join('\n\n'),
    // Compass 及其模型链路均在内网，外发使用用户原文，学员标识与凭证均不伪名化、不脱敏。
    redact: (text) => text,
  });
  // approved 在这里表示 Runtime 已按固定摘要策略自动授权，不代表老师执行过审批。
  return approveExternalConsultation(pending, { conversationId: conversation.id, runId });
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

function requestedScopeFor(content: string): RequestedInvestigationScope | undefined {
  const compact = content.replaceAll(/\s+/g, '');
  const client = /(?:只|仅)(?:查|检查|排查|调查)?(?:客户端|client)/i.test(compact);
  const server = /(?:只|仅)(?:查|检查|排查|调查)?(?:服务端|服务器|server)/i.test(compact);
  return client === server ? undefined : client ? 'client' : 'server';
}

function hasLocalEvidence(conversation: ConversationRecord): boolean {
  const entries = (conversation.evidence_state as { entries?: unknown }).entries;
  return Array.isArray(entries) && entries.length > 0;
}

function hasLogObservation(conversation: ConversationRecord): boolean {
  const entries = (conversation.evidence_state as { entries?: unknown }).entries;
  return Array.isArray(entries) && entries.some((item) =>
    typeof item === 'object' && item !== null && 'kind' in item && item.kind === 'log');
}

function roundResult(
  conversation: ConversationRecord,
  assistantMessage: ChatMessage,
  runId: string,
  terminal: RunDiagnosisRoundResult['terminal'] | null,
  terminalPersisted: boolean,
  text: string,
): RunDiagnosisRoundResult {
  if (!terminal) throw new Error('诊断轮次未到达终态或等待状态');
  return {
    conversation,
    assistantMessage,
    runId,
    terminal,
    terminalPersisted,
    text: assistantMessage.content || text,
  };
}
