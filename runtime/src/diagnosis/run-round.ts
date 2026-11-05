import { randomUUID } from 'node:crypto';

import type { ChatMessage, ConversationRecord } from '../domain/schemas.js';
import type { CapabilityMcp } from '../capabilities/mcp.js';
import type { ModelConfiguration } from '../model/configuration.js';
import type { ProductStore } from '../product/store.js';
import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../security/redaction.js';
import { appendDiagnosisOutcome, archiveDiagnosisCase } from '../observability/cases.js';
import { DiagnosisAgent, type DiagnosisStreamEvent } from './agent.js';

export interface RunDiagnosisRoundOptions {
  knowledgeQueryLog?: string;
  caseArchiveDir?: string;
}

export interface RunDiagnosisRoundInput {
  store: ProductStore;
  diagnosisAgent: DiagnosisAgent;
  capabilities: CapabilityMcp;
  modelConfiguration: ModelConfiguration;
  conversation: ConversationRecord;
  content: string;
  abortSignal?: AbortSignal;
  onPrepared?: (info: {
    conversation: ConversationRecord;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    runId: string;
  }) => void | Promise<void>;
  onEvent?: (event: DiagnosisStreamEvent) => void | Promise<void>;
  options?: RunDiagnosisRoundOptions;
}

export interface RunDiagnosisRoundResult {
  conversation: ConversationRecord;
  assistantMessage: ChatMessage;
  runId: string;
  terminal: 'completed' | 'failed';
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
): Promise<void> {
  await Promise.allSettled([
    archiveDiagnosisCase(options.caseArchiveDir ?? '.data/knowledge-cases', conversation, messageId),
    appendDiagnosisOutcome(options.knowledgeQueryLog ?? '.data/knowledge-queries.jsonl', conversation.id, messageId, verdict, outcome),
  ]);
}

/** Shared diagnosis round used by web SSE and Yach IM; no HTTP/SSE encoding here. */
export async function runDiagnosisRound(input: RunDiagnosisRoundInput): Promise<RunDiagnosisRoundResult> {
  const {
    store,
    diagnosisAgent,
    capabilities,
    modelConfiguration,
    abortSignal,
    onPrepared,
    onEvent,
    options = {},
  } = input;
  const redact = (text: string) => modelConfiguration.redact?.(text) ?? redactSensitiveText(text);
  const saveConversation = async (conversation: ConversationRecord) => {
    await store.saveConversation(redactRecordInPlace(conversation, redact));
  };

  const content = redact(input.content);
  const conversation = input.conversation;
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
  const assistantMessage: ChatMessage = {
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
  conversation.messages.push(userMessage, assistantMessage);
  if (conversation.title === '新会话') {
    conversation.title = content.length > 30 ? `${content.slice(0, 30)}…` : content;
  }
  conversation.updated_at = new Date().toISOString();
  await saveConversation(conversation);

  const runId = `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await onPrepared?.({ conversation, userMessage, assistantMessage, runId });
  let text = '';
  let knowledgeClient: { disconnect(): Promise<void> } | undefined;
  let repositoryClient: { disconnect(): Promise<void> } | undefined;
  let externalKnowledgeClient: { disconnect(): Promise<void> } | undefined;
  let terminal: 'completed' | 'failed' | null = null;

  try {
    const knowledgeSession = await capabilities.createKnowledgeSession(conversation.id, assistantMessage.id);
    knowledgeClient = knowledgeSession?.client;
    let toolsets = knowledgeSession?.toolsets ?? {};
    if (conversation.workspace_path) {
      const repository = await capabilities.createRepositorySession(conversation.id, conversation.workspace_path);
      repositoryClient = repository.client;
      toolsets = { ...toolsets, ...repository.toolsets };
    }
    const externalKnowledge = await capabilities.createExternalKnowledgeTools?.(
      [...conversation.messages.filter((message) => message.role === 'user').map((message) => message.content), content],
    );
    if (externalKnowledge) {
      externalKnowledgeClient = externalKnowledge.client;
      toolsets = { ...toolsets, external_knowledge: externalKnowledge.tools };
    }

    for await (const event of diagnosisAgent.stream({
      conversation,
      content,
      toolsets,
      abortSignal,
    })) {
      await onEvent?.(event);
      if (event.type === 'text') {
        text += redact(event.delta);
      } else if (event.type === 'tool-start') {
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
        await recordTerminalCase(options, conversation, assistantMessage.id, event.report?.verdict ?? null, 'completed');
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
        await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed');
        terminal = 'failed';
      }
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
        await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed');
      } catch {
        console.error('Conversation terminal state persistence failed; restart recovery is required');
      }
      terminal = 'failed';
    }
  } finally {
    await knowledgeClient?.disconnect().catch(() => undefined);
    await repositoryClient?.disconnect().catch(() => undefined);
    await externalKnowledgeClient?.disconnect().catch(() => undefined);
  }

  return {
    conversation,
    assistantMessage,
    runId,
    terminal,
    text: assistantMessage.content || text,
  };
}
