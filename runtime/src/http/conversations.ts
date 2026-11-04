import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';

import {
  CreateConversationRequestSchema,
  ConversationRecordSchema,
  UpdateConversationRequestSchema,
  SendMessageRequestSchema,
  type ChatMessage,
  type ConversationRecord,
} from '../domain/schemas.js';
import { ProductNotFoundError, ProductStore } from '../product/store.js';
import { DiagnosisAgent, type DiagnosisStreamEvent } from '../diagnosis/agent.js';
import { CapabilityMcp } from '../capabilities/mcp.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { RepositoryGitError, RepositoryNotFoundError } from '../capabilities/repository.js';
import { appendDiagnosisOutcome, archiveDiagnosisCase } from '../observability/cases.js';
import { invalidJsonError, requestValidationError } from './errors.js';
import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../security/redaction.js';

interface ConversationRouteOptions {
  knowledgeQueryLog?: string;
  caseArchiveDir?: string;
  createConversationSource?: (input: {
    repositoryId: string | null;
    branch: string | null;
    workspacePath: string | null;
  }) => Promise<Partial<Pick<ConversationRecord, 'workspace_path' | 'repository_id' | 'repository_name' | 'requested_ref' | 'resolved_commit'>>>;
}

async function recordTerminalCase(
  options: ConversationRouteOptions,
  conversation: Awaited<ReturnType<ProductStore['getConversation']>>,
  messageId: string,
  verdict: string | null,
  outcome: 'completed' | 'failed',
): Promise<void> {
  await Promise.allSettled([
    archiveDiagnosisCase(options.caseArchiveDir ?? '.data/knowledge-cases', conversation, messageId),
    appendDiagnosisOutcome(options.knowledgeQueryLog ?? '.data/knowledge-queries.jsonl', conversation.id, messageId, verdict, outcome),
  ]);
}

function publicConversation(value: ReturnType<typeof ConversationRecordSchema.parse>) {
  const { messages_state: _messagesState, evidence_state: _evidenceState, ...publicValue } = value;
  return publicValue;
}

function jsonError(message: string, status: 400 | 404 | 409 | 422 | 503) {
  return new Response(JSON.stringify({ detail: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(type: string, runId: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, run_id: runId, timestamp: new Date().toISOString(), ...payload })}\n\n`;
}

function streamHeaders(): Headers {
  return new Headers({
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
    'x-accel-buffering': 'no',
  });
}

async function persistTerminalConversation(
  save: (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) => Promise<void>,
  conversation: Awaited<ReturnType<ProductStore['getConversation']>>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await save(conversation);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function createConversationRoutes(
  store: ProductStore,
  diagnosisAgent?: DiagnosisAgent,
  capabilities?: CapabilityMcp,
  modelConfiguration?: ModelConfiguration,
  options: ConversationRouteOptions = {},
): Hono {
  const routes = new Hono();
  const activeRuns = new Set<string>();
  const redact = (text: string) => modelConfiguration?.redact?.(text) ?? redactSensitiveText(text);
  const saveConversation = async (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) => {
    await store.saveConversation(redactRecordInPlace(conversation, redact));
  };
  const publicView = (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) =>
    publicConversation(redactRecord(conversation, redact));

  routes.get('/conversations', async (context) => context.json((await store.listConversations()).map((item) => redactRecord(item, redact))));

  routes.post('/conversations', async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return invalidJsonError();
    }
    const parsed = CreateConversationRequestSchema.safeParse(payload);
    if (!parsed.success) return requestValidationError(parsed.error.issues);
    try {
      const source = await options.createConversationSource?.({ repositoryId: parsed.data.repository_id, branch: parsed.data.branch, workspacePath: parsed.data.workspace_path });
      const conversation = await store.createConversation({ title: parsed.data.title ?? '新会话', ...source });
      return context.json(publicView(conversation), 201);
    } catch (error) {
      if (error instanceof ProductNotFoundError || error instanceof RepositoryNotFoundError) return jsonError('repository not found', 404);
      if (error instanceof RepositoryGitError) return jsonError(error.message, 422);
      throw error;
    }
  });

  routes.get('/conversations/:id', async (context) => {
    try {
      return context.json(publicView(await store.getConversation(context.req.param('id'))));
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });

  routes.patch('/conversations/:id', async (context) => {
    const id = context.req.param('id');
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return invalidJsonError();
    }
    const update = UpdateConversationRequestSchema.safeParse(payload);
    if (!update.success) return requestValidationError(update.error.issues);
    try {
      const current = await store.getConversation(id);
      const updated = await store.saveConversation({
        ...current,
        ...update.data,
        title: update.data.title ?? current.title,
        model_override: update.data.model_override === ''
          ? null
          : update.data.model_override ?? current.model_override,
        updated_at: new Date().toISOString(),
      });
      return context.json(publicView(updated));
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });

  routes.delete('/conversations/:id', async (context) => {
    try {
      await store.deleteConversation(context.req.param('id'));
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });

  routes.post('/conversations/:id/messages', async (context) => {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return invalidJsonError();
    }
    const parsedInput = SendMessageRequestSchema.safeParse(input);
    if (!parsedInput.success) return requestValidationError(parsedInput.error.issues);
    if (!diagnosisAgent || !capabilities || !modelConfiguration?.enabled) {
      return jsonError('聊天需要先在模型设置中配置模型', 409);
    }
    const content = redact(parsedInput.data.content);
    const id = context.req.param('id');
    let conversation;
    try {
      conversation = await store.getConversation(id);
      redactRecordInPlace(conversation, redact);
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
    if (activeRuns.has(id) || conversation.messages.some((message) => message.status === 'streaming')) {
      return jsonError('上一条回复尚未完成，请稍后再发送', 409);
    }
    activeRuns.add(id);
    const userMessage: ChatMessage = {
      id: `msg-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      role: 'user' as const,
      content,
      steps: [],
      status: 'completed' as const,
      error: null,
      report: null,
      input_tokens: null,
      output_tokens: null,
      tool_usage: {},
      created_at: new Date().toISOString(),
    };
    const assistantMessage: ChatMessage = {
      id: `msg-${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      role: 'assistant' as const,
      content: '',
      steps: [],
      status: 'streaming' as const,
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
    try {
      await saveConversation(conversation);
    } catch (error) {
      activeRuns.delete(id);
      throw error;
    }
    const runId = `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const runController = new AbortController();
    const signal = AbortSignal.any([context.req.raw.signal, runController.signal]);

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let text = '';
        let knowledgeClient: { disconnect(): Promise<void> } | undefined;
        let repositoryClient: { disconnect(): Promise<void> } | undefined;
        let externalKnowledgeClient: { disconnect(): Promise<void> } | undefined;
        let terminalSent = false;
        let terminalPersisted = false;
        let textStarted = false;
        let streamClosed = false;
        const send = (value: string) => {
          if (streamClosed) return;
          try {
            controller.enqueue(encoder.encode(value));
          } catch {
            streamClosed = true;
            runController.abort();
          }
        };
        const keepalive = setInterval(() => {
          if (!terminalSent) send(': keepalive\n\n');
        }, 10_000);
        try {
          send(sse('RUN_STARTED', runId, { conversation_id: id, conversation: publicView(conversation) }));
          const knowledgeSession = await capabilities.createKnowledgeSession(id, assistantMessage.id);
          knowledgeClient = knowledgeSession?.client;
          let toolsets = knowledgeSession?.toolsets ?? {};
          if (conversation.workspace_path) {
            const repository = await capabilities.createRepositorySession(id, conversation.workspace_path);
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
            abortSignal: signal,
          })) {
            if (event.type === 'text') {
              const delta = redact(event.delta);
              text += delta;
              if (!textStarted) {
                textStarted = true;
                send(sse('TEXT_MESSAGE_START', runId, { message_id: assistantMessage.id }));
              }
              send(sse('TEXT_MESSAGE_CONTENT', runId, { message_id: assistantMessage.id, delta }));
            } else if (event.type === 'tool-start') {
              const safeEvent = redactRecord(event.event, redact);
              assistantMessage.steps.push(safeEvent);
              conversation.updated_at = new Date().toISOString();
              await saveConversation(conversation);
              send(sse('TOOL_CALL_START', runId, { message_id: assistantMessage.id, tool_event: safeEvent }));
            } else if (event.type === 'tool-end') {
              const safeEvent = redactRecord(event.event, redact);
              assistantMessage.steps = assistantMessage.steps.map((step) => step.id === safeEvent.id ? safeEvent : step);
              conversation.evidence_state = redactRecord(event.evidence_state, redact);
              conversation.updated_at = new Date().toISOString();
              await saveConversation(conversation);
              send(sse('TOOL_CALL_END', runId, { message_id: assistantMessage.id, tool_event: safeEvent }));
            } else if (event.type === 'completed' && !terminalSent) {
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
              await recordTerminalCase(options, conversation, assistantMessage.id, event.report?.verdict ?? null, 'completed');
              if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessage.id }));
              send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicView(conversation) }));
              send(sse('RUN_FINISHED', runId, { conversation_id: id, conversation: publicView(conversation) }));
              terminalSent = true;
            } else if (event.type === 'failed' && !terminalSent) {
              const interrupted = signal.aborted;
              const failureCategory = interrupted ? 'cancelled' : event.failure_category;
              assistantMessage.content = redact(text);
              assistantMessage.status = 'failed';
              assistantMessage.error = interrupted ? '回复中断：请求已取消' : redact(event.error);
              assistantMessage.report = null;
              assistantMessage.tool_usage = { ...event.tool_usage, failure_category: failureCategory };
              assistantMessage.input_tokens = event.input_tokens;
              assistantMessage.output_tokens = event.output_tokens;
              assistantMessage.steps = assistantMessage.steps.map((step) => step.status === 'running'
                ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
                : step);
              conversation.evidence_state = redactRecord(event.evidence_state, redact);
              conversation.updated_at = new Date().toISOString();
              await persistTerminalConversation(saveConversation, conversation);
              terminalPersisted = true;
              await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed');
              if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessage.id }));
              send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicView(conversation) }));
              send(sse('RUN_ERROR', runId, { conversation_id: id, message_id: assistantMessage.id, error: assistantMessage.error, failure_category: failureCategory, conversation: publicView(conversation) }));
              terminalSent = true;
            }
          }
          if (!terminalSent) throw new Error('诊断流在终态事件前结束');
        } catch (error) {
          const interrupted = signal.aborted;
          const failureCategory = interrupted ? 'cancelled' : 'runtime_error';
          assistantMessage.content = redact(text);
          assistantMessage.status = 'failed';
          assistantMessage.error = interrupted
            ? '回复中断：请求已取消'
            : redact(error instanceof Error ? error.message : '诊断运行失败');
          assistantMessage.report = null;
          assistantMessage.tool_usage = { ...assistantMessage.tool_usage, failure_category: failureCategory };
          assistantMessage.steps = assistantMessage.steps.map((step) => step.status === 'running'
            ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
            : step);
          conversation.updated_at = new Date().toISOString();
          try {
            await persistTerminalConversation(saveConversation, conversation);
            terminalPersisted = true;
            await recordTerminalCase(options, conversation, assistantMessage.id, null, 'failed');
          } catch {
            console.error('Conversation terminal state persistence failed; restart recovery is required');
          }
          if (!terminalSent) {
            if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessage.id }));
            send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicView(conversation) }));
            send(sse('RUN_ERROR', runId, { conversation_id: id, message_id: assistantMessage.id, error: assistantMessage.error, failure_category: failureCategory, conversation: publicView(conversation) }));
            terminalSent = true;
          }
        } finally {
          clearInterval(keepalive);
          await knowledgeClient?.disconnect().catch(() => undefined);
          await repositoryClient?.disconnect().catch(() => undefined);
          await externalKnowledgeClient?.disconnect().catch(() => undefined);
          if (terminalPersisted) activeRuns.delete(id);
          if (!streamClosed) controller.close();
        }
      },
      cancel() {
        runController.abort();
      },
    });
    return new Response(body, { headers: streamHeaders() });
  });

  return routes;
}
