import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';

import {
  CreateConversationRequestSchema,
  ConversationRecordSchema,
  RenameConversationRequestSchema,
  UpdateConversationRequestSchema,
  SendMessageRequestSchema,
  type ChatMessage,
  type ConversationRecord,
} from '../domain/schemas.js';
import { ProductNotFoundError, ProductStore } from '../product/store.js';
import { DiagnosisAgent, type DiagnosisStreamEvent } from '../diagnosis/agent.js';
import { CapabilityMcp } from '../capabilities/mcp.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { RepositoryNotFoundError } from '../capabilities/repository.js';

interface ConversationRouteOptions {
  createConversationSource?: (input: {
    repositoryId: string | null;
    branch: string | null;
    workspacePath: string | null;
  }) => Promise<Partial<Pick<ConversationRecord, 'workspace_path' | 'repository_id' | 'repository_name' | 'requested_ref' | 'resolved_commit'>>>;
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

export function createConversationRoutes(
  store: ProductStore,
  diagnosisAgent?: DiagnosisAgent,
  capabilities?: CapabilityMcp,
  modelConfiguration?: ModelConfiguration,
  options: ConversationRouteOptions = {},
): Hono {
  const routes = new Hono();

  routes.get('/conversations', async (context) => context.json(await store.listConversations()));

  routes.post('/conversations', async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return jsonError('invalid JSON body', 422);
    }
    const parsed = CreateConversationRequestSchema.safeParse(payload);
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'invalid request', 422);
    try {
      const source = await options.createConversationSource?.({ repositoryId: parsed.data.repository_id, branch: parsed.data.branch, workspacePath: parsed.data.workspace_path });
      const conversation = await store.createConversation({ title: parsed.data.title ?? '新会话', ...source });
      return context.json(publicConversation(conversation), 201);
    } catch (error) {
      if (error instanceof ProductNotFoundError || error instanceof RepositoryNotFoundError) return jsonError('repository not found', 404);
      if (error instanceof Error) return jsonError(error.message, 422);
      throw error;
    }
  });

  routes.get('/conversations/:id', async (context) => {
    try {
      return context.json(publicConversation(await store.getConversation(context.req.param('id'))));
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
      return jsonError('invalid JSON body', 422);
    }
    const update = UpdateConversationRequestSchema.safeParse(payload);
    if (!update.success) return jsonError(update.error.issues[0]?.message ?? 'invalid request', 422);
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
      return context.json(publicConversation(updated));
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
    if (!diagnosisAgent || !capabilities || !modelConfiguration?.enabled) {
      return jsonError('聊天需要先在模型设置中配置模型', 409);
    }
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return jsonError('invalid JSON body', 422);
    }
    const parsedInput = SendMessageRequestSchema.safeParse(input);
    if (!parsedInput.success) return jsonError(parsedInput.error.issues[0]?.message ?? 'invalid request', 422);
    const content = parsedInput.data.content;
    const id = context.req.param('id');
    let conversation;
    try {
      conversation = await store.getConversation(id);
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
    if (conversation.messages.some((message) => message.status === 'streaming')) {
      return jsonError('上一条回复尚未完成，请稍后再发送', 409);
    }
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
    if (conversation.title === '新会话') conversation.title = content.slice(0, 30);
    conversation.updated_at = new Date().toISOString();
    await store.saveConversation(conversation);
    const runId = `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const runController = new AbortController();
    const signal = AbortSignal.any([context.req.raw.signal, runController.signal]);

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let text = '';
        let repositoryClient: { disconnect(): Promise<void> } | undefined;
        let terminalSent = false;
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
          send(sse('RUN_STARTED', runId, { conversation_id: id, conversation: publicConversation(conversation) }));
          const knowledge = await capabilities.knowledgeToolsets();
          let toolsets = knowledge;
          if (conversation.workspace_path) {
            const repository = await capabilities.createRepositorySession(id, conversation.workspace_path);
            repositoryClient = repository.client;
            toolsets = { ...knowledge, ...repository.toolsets };
          }
          for await (const event of diagnosisAgent.stream({
            conversation,
            content,
            toolsets,
            abortSignal: signal,
          })) {
            if (event.type === 'text') {
              text += event.delta;
              if (!textStarted) {
                textStarted = true;
                send(sse('TEXT_MESSAGE_START', runId, { message_id: assistantMessage.id }));
              }
              send(sse('TEXT_MESSAGE_CONTENT', runId, { message_id: assistantMessage.id, delta: event.delta }));
            } else if (event.type === 'tool-start') {
              assistantMessage.steps.push(event.event);
              send(sse('TOOL_CALL_START', runId, { message_id: assistantMessage.id, tool_event: event.event }));
            } else if (event.type === 'tool-end') {
              assistantMessage.steps = assistantMessage.steps.map((step) => step.id === event.event.id ? event.event : step);
              send(sse('TOOL_CALL_END', runId, { message_id: assistantMessage.id, tool_event: event.event }));
            } else if (event.type === 'completed' && !terminalSent) {
              assistantMessage.content = event.text;
              assistantMessage.status = 'completed';
              assistantMessage.report = event.report;
              assistantMessage.tool_usage = event.tool_usage;
              conversation.evidence_state = event.evidence_state;
              conversation.messages_state = event.messages_state as Array<Record<string, unknown>>;
              conversation.updated_at = new Date().toISOString();
              await store.saveConversation(conversation);
              if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessage.id }));
              send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicConversation(conversation) }));
              send(sse('RUN_FINISHED', runId, { conversation_id: id, conversation: publicConversation(conversation) }));
              terminalSent = true;
            } else if (event.type === 'failed' && !terminalSent) {
              assistantMessage.content = text;
              assistantMessage.status = 'failed';
              assistantMessage.error = event.error;
              assistantMessage.report = null;
              assistantMessage.tool_usage = event.tool_usage;
              assistantMessage.steps = assistantMessage.steps.map((step) => step.status === 'started'
                ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
                : step);
              conversation.evidence_state = event.evidence_state;
              conversation.updated_at = new Date().toISOString();
              await store.saveConversation(conversation);
              if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessage.id }));
              send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicConversation(conversation) }));
              send(sse('RUN_ERROR', runId, { conversation_id: id, message_id: assistantMessage.id, error: event.error, conversation: publicConversation(conversation) }));
              terminalSent = true;
            }
          }
        } catch (error) {
          assistantMessage.content = text;
          assistantMessage.status = 'failed';
          assistantMessage.error = error instanceof Error ? error.message : '诊断运行失败';
          assistantMessage.report = null;
          assistantMessage.steps = assistantMessage.steps.map((step) => step.status === 'started'
            ? { ...step, status: 'failed', summary: '工具调用中断，结果未知' }
            : step);
          conversation.updated_at = new Date().toISOString();
          await store.saveConversation(conversation);
          if (!terminalSent) {
            if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessage.id }));
            send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicConversation(conversation) }));
            send(sse('RUN_ERROR', runId, { conversation_id: id, message_id: assistantMessage.id, error: assistantMessage.error, conversation: publicConversation(conversation) }));
            terminalSent = true;
          }
        } finally {
          clearInterval(keepalive);
          await repositoryClient?.disconnect().catch(() => undefined);
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

export function createRenameConversationRoute(store: ProductStore): Hono {
  const routes = new Hono();
  routes.post('/conversations/:id/rename', async (context) => {
    const update = RenameConversationRequestSchema.safeParse(await context.req.json());
    if (!update.success) return jsonError(update.error.issues[0]?.message ?? 'invalid request', 422);
    try {
      const current = await store.getConversation(context.req.param('id'));
      const updated = await store.saveConversation({
        ...current,
        title: update.data.title,
        updated_at: new Date().toISOString(),
      });
      return context.json(publicConversation(updated));
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });
  return routes;
}
