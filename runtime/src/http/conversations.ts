import { Hono, type Context } from 'hono';

import {
  CreateConversationRequestSchema,
  ConversationRecordSchema,
  UpdateConversationRequestSchema,
  SendMessageRequestSchema,
  type ConversationRecord,
} from '../domain/schemas.js';
import { ProductNotFoundError, ProductStore } from '../product/store.js';
import { DiagnosisAgent } from '../diagnosis/agent.js';
import {
  prepareDiagnosisRound,
  runDiagnosisRound,
  type ConsultationResumeDecision,
  type PreparedDiagnosisRound,
} from '../diagnosis/run-round.js';
import { CapabilityMcp } from '../capabilities/mcp.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { RepositoryGitError } from '../capabilities/repository.js';
import { invalidJsonError, requestValidationError } from './errors.js';
import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../security/redaction.js';
import type { AuthVariables } from '../auth/index.js';
import { InMemoryRunAdmission, type RunAdmission, type RunAdmissionGrant } from '../orchestration/admission.js';
import type { ServerSignals } from '../orchestration/server-signals.js';
import type { AgentSlotRegistry } from '../orchestration/agent-slot-registry.js';
import type { InvestigationBudget } from '../orchestration/plan.js';
import { ExternalConsultationError } from '../orchestration/consultation.js';
import { clearIncompleteSourceBinding, type BoundSourceContext } from '../capabilities/source-binding.js';

interface ConversationRouteOptions {
  knowledgeQueryLog?: string;
  caseArchiveDir?: string;
  admission?: RunAdmission;
  serverSignals?: ServerSignals;
  slotRegistry?: AgentSlotRegistry;
  compassAvailable?: boolean;
  investigationBudget?: InvestigationBudget;
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

function publicConversation(value: ReturnType<typeof ConversationRecordSchema.parse>) {
  const { messages_state: _messagesState, evidence_state: _evidenceState, ...publicValue } = value;
  return publicValue;
}

function jsonError(message: string, status: 400 | 403 | 404 | 409 | 422 | 503) {
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
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const admission = options.admission ?? new InMemoryRunAdmission(4);
  const redact = (text: string) => modelConfiguration?.redact?.(text) ?? redactSensitiveText(text);
  const saveConversation = async (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) => {
    await store.saveConversation(redactRecordInPlace(conversation, redact));
  };
  const publicView = (conversation: Awaited<ReturnType<ProductStore['getConversation']>>) =>
    publicConversation(redactRecord(conversation, redact));

  const streamPreparedRound = (input: {
    id: string;
    prepared: PreparedDiagnosisRound;
    admissionGrant: RunAdmissionGrant;
    content: string;
    resume?: { consultationId: string; decision: ConsultationResumeDecision };
    requestSignal: AbortSignal;
  }): Response => {
    if (!diagnosisAgent || !capabilities || !modelConfiguration) {
      throw new Error('诊断运行依赖尚未配置');
    }
    const { id, prepared, admissionGrant, content, resume, requestSignal } = input;
    const runController = new AbortController();
    const signal = AbortSignal.any([requestSignal, runController.signal]);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let streamClosed = false;
        let terminalSent = false;
        let terminalPersisted = false;
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
            conversation: prepared.conversation,
            prepared,
            content,
            resume,
            abortSignal: signal,
            options: {
              knowledgeQueryLog: options.knowledgeQueryLog,
              caseArchiveDir: options.caseArchiveDir,
              serverSignals: options.serverSignals,
              slotRegistry: options.slotRegistry,
              compassAvailable: options.compassAvailable,
              investigationBudget: options.investigationBudget,
              createConversationSource: options.createConversationSource,
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
            onOrchestrationEvent: (event) => {
              const { type, runId: eventRunId, ...payload } = event;
              send(sse(type, runId || eventRunId, redactRecord(payload, redact)));
            },
          });
          runId = result.runId;
          terminalPersisted = result.terminalPersisted;
          if (textStarted) send(sse('TEXT_MESSAGE_END', runId, { message_id: result.assistantMessage.id }));
          send(sse('STATE_SNAPSHOT', runId, { conversation_id: id, conversation: publicView(result.conversation) }));
          if (result.terminal === 'completed') {
            send(sse('RUN_FINISHED', runId, { conversation_id: id, conversation: publicView(result.conversation) }));
          } else if (result.terminal === 'failed') {
            send(sse('RUN_ERROR', runId, {
              conversation_id: id,
              message_id: result.assistantMessage.id,
              error: result.assistantMessage.error,
              failure_category: result.assistantMessage.tool_usage.failure_category ?? 'runtime_error',
              conversation: publicView(result.conversation),
            }));
          }
          // waiting_confirmation 只发送确认事件和状态快照，不伪装成完成或失败。
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
          if (terminalPersisted) await admission.release(admissionGrant.runId);
          if (!streamClosed) controller.close();
        }
      },
      cancel() {
        runController.abort();
      },
    });
    return new Response(body, { headers: streamHeaders() });
  };

  routes.get('/conversations', async (context) => {
    const items = (await store.listConversations())
      .filter((item) => item.channel !== 'yach_im')
      .map((item) => {
        const { channel: _channel, ...publicItem } = item;
        return redactRecord(publicItem, redact);
      });
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
      const conversation = await store.createConversation({
        title: parsed.data.title ?? '新会话',
        owner_subject: context.get('identity')?.subject ?? null,
      });
      return context.json(publicView(redactRecord(conversation, redact)), 201);
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('repository not found', 404);
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
      if (parsed.data.title != null) conversation.title = parsed.data.title;
      if (parsed.data.model_override !== undefined) conversation.model_override = parsed.data.model_override || null;
      if (parsed.data.consult_compass !== undefined) conversation.consult_compass = parsed.data.consult_compass;
      conversation.updated_at = new Date().toISOString();
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
    if (conversation.run_state === 'waiting_confirmation') {
      return jsonError('当前诊断正在等待外发确认，请先处理确认请求', 409);
    }
    if (conversation.messages.some((message) => message.status === 'streaming')) {
      return jsonError('上一条回复尚未完成，请稍后再发送', 409);
    }
    const acquired = await admission.acquire({ conversationId: id });
    if (!acquired.ok) {
      if (acquired.reason === 'conversation_busy') {
        return jsonError('上一条回复尚未完成，请稍后再发送', 409);
      }
      return new Response(JSON.stringify({ detail: '当前诊断任务较多，请稍后重试', retry_after: 1 }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      });
    }
    const admissionGrant = acquired.grant;
    let prepared;
    try {
      clearIncompleteSourceBinding(conversation);
      prepared = await prepareDiagnosisRound({
        store,
        modelConfiguration,
        conversation,
        content: parsedInput.data.content,
        runId: admissionGrant.runId,
      });
    } catch (error) {
      await admission.release(admissionGrant.runId);
      if (error instanceof RepositoryGitError) return jsonError(error.message, 422);
      throw error;
    }
    return streamPreparedRound({
      id,
      prepared,
      admissionGrant,
      content: parsedInput.data.content,
      requestSignal: context.req.raw.signal,
    });
  });

  const consultationDecision = async (
    context: Context<{ Variables: AuthVariables }>,
    decision: 'approved' | 'rejected',
  ) => {
    const rawBody = await context.req.text();
    if (rawBody.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return invalidJsonError();
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
        return jsonError('确认接口不接受新的外发内容或附加字段', 422);
      }
    }
    if (!diagnosisAgent || !capabilities || !modelConfiguration?.enabled) {
      return jsonError('聊天需要先在模型设置中配置模型', 409);
    }
    const id = context.req.param('id') ?? '';
    const consultationId = context.req.param('consultationId') ?? '';
    let conversation;
    try {
      conversation = await store.getConversation(id);
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
    const subject = context.get('identity')?.subject;
    if (!subject || !conversation.owner_subject || conversation.owner_subject !== subject) {
      return jsonError('无权处理该会话的外发确认', 403);
    }
    if (conversation.run_state !== 'waiting_confirmation') {
      return jsonError('当前会话没有等待处理的外发确认', 409);
    }
    const consultation = conversation.consultations.find((item) => item.id === consultationId);
    if (!consultation) return jsonError('consultation not found', 404);

    const acquired = await admission.acquire({ conversationId: id });
    if (!acquired.ok) {
      if (acquired.reason === 'conversation_busy') return jsonError('该会话正在处理其他任务', 409);
      return new Response(JSON.stringify({ detail: '当前诊断任务较多，请稍后重试', retry_after: 1 }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      });
    }
    const admissionGrant = acquired.grant;
    let prepared: PreparedDiagnosisRound;
    let resume: { consultationId: string; decision: ConsultationResumeDecision } = {
      consultationId,
      decision,
    };
    const prepareResume = () => prepareDiagnosisRound({
      store,
      modelConfiguration,
      conversation,
      content: '',
      runId: admissionGrant.runId,
      resume,
    });
    try {
      redactRecordInPlace(conversation, redact);
      try {
        prepared = await prepareResume();
      } catch (error) {
        if (!(error instanceof ExternalConsultationError) || error.code !== 'expired') throw error;
        // 过期是调查的可恢复终态：保留本地事实，不落 approved/rejected，也不调用远端。
        resume = { consultationId, decision: 'expired' };
        prepared = await prepareResume();
      }
    } catch (error) {
      await admission.release(admissionGrant.runId);
      if (error instanceof ExternalConsultationError) return jsonError(error.message, 409);
      throw error;
    }
    return streamPreparedRound({
      id,
      prepared,
      admissionGrant,
      content: '',
      resume,
      requestSignal: context.req.raw.signal,
    });
  };

  routes.post('/conversations/:id/consultations/:consultationId/approve', (context) =>
    consultationDecision(context, 'approved'));
  routes.post('/conversations/:id/consultations/:consultationId/reject', (context) =>
    consultationDecision(context, 'rejected'));

  return routes;
}
