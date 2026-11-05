import { Hono } from 'hono';

import {
  CreateConversationRequestSchema,
  ConversationRecordSchema,
  UpdateConversationRequestSchema,
  SendMessageRequestSchema,
  type ConversationRecord,
} from '../domain/schemas.js';
import { ProductNotFoundError, ProductStore } from '../product/store.js';
import { DiagnosisAgent } from '../diagnosis/agent.js';
import { runDiagnosisRound } from '../diagnosis/run-round.js';
import { CapabilityMcp } from '../capabilities/mcp.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { RepositoryGitError, RepositoryNotFoundError } from '../capabilities/repository.js';
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
  const activeRuns = new Set<string>();
  const redact = (text: string) => modelConfiguration?.redact?.(text) ?? redactSensitiveText(text);
  const saveConversation = async (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) => {
    await store.saveConversation(redactRecordInPlace(conversation, redact));
  };
  const publicView = (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) =>
    publicConversation(redactRecord(conversation, redact));

  routes.get('/conversations', async (context) => {
    const items = (await store.listConversations())
      .filter((item) => item.channel !== 'yach_im')
      .map((item) => redactRecord(item, redact));
    return context.json(items);
  });

  routes.post('/conversations', async (context) => {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return invalidJsonError();
    }
    const parsed = CreateConversationRequestSchema.safeParse(input);
    if (!parsed.success) return requestValidationError(parsed.error.issues);
    try {
      const source = await options.createConversationSource?.({
        repositoryId: parsed.data.repository_id,
        branch: parsed.data.branch,
        workspacePath: parsed.data.workspace_path,
      });
      const conversation = await store.createConversation({ title: parsed.data.title ?? '新会话', ...source });
      return context.json(publicView(redactRecord(conversation, redact)), 201);
    } catch (error) {
      if (error instanceof RepositoryNotFoundError) return jsonError(error.message, 404);
      if (error instanceof RepositoryGitError) return jsonError(error.message, 422);
      throw error;
    }
  });

  routes.get('/conversations/:id', async (context) => {
    try {
      const conversation = await store.getConversation(context.req.param('id'));
      if (conversation.channel === 'yach_im') return jsonError('conversation not found', 404);
      return context.json(publicView(redactRecord(conversation, redact)));
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });

  routes.patch('/conversations/:id', async (context) => {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return invalidJsonError();
    }
    const parsed = UpdateConversationRequestSchema.safeParse(input);
    if (!parsed.success) return requestValidationError(parsed.error.issues);
    try {
      const conversation = await store.getConversation(context.req.param('id'));
      if (conversation.channel === 'yach_im') return jsonError('conversation not found', 404);
      Object.assign(conversation, parsed.data, { updated_at: new Date().toISOString() });
      await saveConversation(conversation);
      return context.json(publicView(redactRecord(conversation, redact)));
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });

  routes.delete('/conversations/:id', async (context) => {
    try {
      const conversation = await store.getConversation(context.req.param('id'));
      if (conversation.channel === 'yach_im') return jsonError('conversation not found', 404);
      await store.deleteConversation(context.req.param('id'));
      return context.body(null, 204);
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
    const id = context.req.param('id');
    let conversation;
    try {
      conversation = await store.getConversation(id);
      if (conversation.channel === 'yach_im') return jsonError('conversation not found', 404);
      redactRecordInPlace(conversation, redact);
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
    if (activeRuns.has(id) || conversation.messages.some((message) => message.status === 'streaming')) {
      return jsonError('上一条回复尚未完成，请稍后再发送', 409);
    }
    activeRuns.add(id);
    const runController = new AbortController();
    const signal = AbortSignal.any([context.req.raw.signal, runController.signal]);

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let streamClosed = false;
        let terminalSent = false;
        let textStarted = false;
        let runId = '';
        let assistantMessageId = '';
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
          const result = await runDiagnosisRound({
            store,
            diagnosisAgent,
            capabilities,
            modelConfiguration,
            conversation,
            content: parsedInput.data.content,
            abortSignal: signal,
            options: {
              knowledgeQueryLog: options.knowledgeQueryLog,
              caseArchiveDir: options.caseArchiveDir,
            },
            onPrepared: ({ assistantMessage, runId: preparedRunId, conversation: prepared }) => {
              runId = preparedRunId;
              assistantMessageId = assistantMessage.id;
              send(sse('RUN_STARTED', runId, { conversation_id: id, conversation: publicView(prepared) }));
            },
            onEvent: async (event) => {
              if (!runId) return;
              if (event.type === 'text') {
                const delta = redact(event.delta);
                if (!textStarted) {
                  textStarted = true;
                  send(sse('TEXT_MESSAGE_START', runId, { message_id: assistantMessageId }));
                }
                send(sse('TEXT_MESSAGE_CONTENT', runId, { message_id: assistantMessageId, delta }));
              } else if (event.type === 'tool-start') {
                send(sse('TOOL_CALL_START', runId, {
                  message_id: assistantMessageId,
                  tool_event: redactRecord(event.event, redact),
                }));
              } else if (event.type === 'tool-end') {
                send(sse('TOOL_CALL_END', runId, {
                  message_id: assistantMessageId,
                  tool_event: redactRecord(event.event, redact),
                }));
              }
            },
          });
          runId = result.runId;
          if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: result.assistantMessage.id }));
          send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicView(result.conversation) }));
          if (result.terminal === 'completed') {
            send(sse('RUN_FINISHED', runId, { conversation_id: id, conversation: publicView(result.conversation) }));
          } else {
            send(sse('RUN_ERROR', runId, {
              conversation_id: id,
              message_id: result.assistantMessage.id,
              error: result.assistantMessage.error,
              failure_category: result.assistantMessage.tool_usage.failure_category ?? 'runtime_error',
              conversation: publicView(result.conversation),
            }));
          }
          terminalSent = true;
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : '诊断运行失败');
          if (runId) {
            if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: assistantMessageId }));
            send(sse('RUN_ERROR', runId, {
              conversation_id: id,
              message_id: assistantMessageId,
              error: message,
              failure_category: signal.aborted ? 'cancelled' : 'runtime_error',
            }));
            terminalSent = true;
          }
        } finally {
          clearInterval(keepalive);
          activeRuns.delete(id);
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
