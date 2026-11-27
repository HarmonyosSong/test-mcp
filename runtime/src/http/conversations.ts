import { Hono, type Context } from 'hono';
import { readFile } from 'node:fs/promises';

import { findConversationObservabilityDir } from '../observability/conversation-span-file-exporter.js';

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
  type InvestigationBudget,
  type PreparedDiagnosisRound,
} from '../diagnosis/run-round.js';
import { CapabilityMcp } from '../capabilities/mcp.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { RepositoryGitError } from '../capabilities/repository.js';
import { invalidJsonError, requestValidationError } from './errors.js';
import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../security/redaction.js';
import type { AuthVariables } from '../auth/index.js';
import { InMemoryRunAdmission, type RunAdmission, type RunAdmissionGrant } from '../orchestration/admission.js';
import type { AgentSlotRegistry } from '../orchestration/agent-slot-registry.js';
import { clearIncompleteSourceBinding, type BoundSourceContext } from '../capabilities/source-binding.js';
import type { RuntimeConfig } from '../config.js';
import { enrichSimulationLoginReply } from '../capabilities/simulation-login-reply.js';
import { clearSimulationLoginTokens } from '../capabilities/simulation-login-tokens.js';

interface ConversationRouteOptions {
  config?: RuntimeConfig;
  knowledgeQueryLog?: string;
  caseArchiveDir?: string;
  /** 调试面板读取已落盘 AI trace（.data/observability）；缺省不提供 ai-traces 接口。 */
  observabilityDir?: string;
  admission?: RunAdmission;
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
  /** 三方 SDK 二进制反编译能力（decompile_binary）；配置完成才挂载。 */
  decompileBinary?: {
    jadxPath: string;
    cacheRoot: string;
  };
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
    requestSignal: AbortSignal;
    ownerSubject?: string;
  }): Response => {
    if (!diagnosisAgent || !capabilities || !modelConfiguration) {
      throw new Error('诊断运行依赖尚未配置');
    }
    const { id, prepared, admissionGrant, content, requestSignal, ownerSubject } = input;
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
          if (!streamClosed) send(': keepalive\n\n');
        }, 10_000);
        // 后台协查：终态事件照发，但连接保持到协查结果落地（或客户端断开/超时），
        // 让 web 用户不刷新也能看到协查结论。
        let followupResolve!: () => void;
        const followupDone = new Promise<void>((resolve) => { followupResolve = resolve; });
        const clientGone = new Promise<void>((resolve) => {
          if (requestSignal.aborted) resolve();
          else requestSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        try {
          const result = await runDiagnosisRound({
            store,
            diagnosisAgent,
            capabilities,
            modelConfiguration,
            conversation: prepared.conversation,
            prepared,
            content,
            abortSignal: signal,
            options: {
              knowledgeQueryLog: options.knowledgeQueryLog,
              caseArchiveDir: options.caseArchiveDir,
              slotRegistry: options.slotRegistry,
              compassAvailable: options.compassAvailable,
              investigationBudget: options.investigationBudget,
              createConversationSource: options.createConversationSource,
              decompileBinary: options.decompileBinary,
              onCompassFollowupSettled: ({ conversation: settled, message: followupMessage }) => {
                send(sse('STATE_SNAPSHOT', runId, {
                  conversation_id: id,
                  followup_message_id: followupMessage.id,
                  conversation: publicView(settled),
                }));
                followupResolve();
              },
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
          terminalPersisted = result.terminalPersisted;
          // 失败轮不走出站后处理：登记在本轮消息上的 Token 直接清掉，防驻留。
          if (result.terminal === 'failed') clearSimulationLoginTokens(result.assistantMessage.id);
          // enrich 双形态：persist（无签名 URL）落库；outbound（含二维码）只随终态事件出站。
          let persistContent: string | null = null;
          if (result.terminal === 'completed' && options.config) {
            try {
              const enriched = await enrichSimulationLoginReply({
                text: result.assistantMessage.content || result.text,
                messageId: result.assistantMessage.id,
                owner: ownerSubject || result.conversation.owner_subject || 'anonymous',
                config: options.config,
              });
              if (enriched.persist !== result.assistantMessage.content) {
                result.assistantMessage.content = enriched.persist;
                await store.saveConversation(result.conversation);
              }
              if (enriched.outbound !== result.assistantMessage.content) {
                persistContent = result.assistantMessage.content;
                result.assistantMessage.content = enriched.outbound;
              }
            } catch {
              // 出图失败不阻断网页终态。
            }
          }
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
          terminalSent = true;
          if (persistContent !== null) {
            // 出站事件已发完，立刻恢复落库版：协查 settle 等后续写库不得把签名 URL 带进去。
            result.assistantMessage.content = persistContent;
          }
          if (result.compassFollowupPending) {
            send(sse('FOLLOWUP_PENDING', runId, { conversation_id: id }));
            // 协查后台等待（上限=远端 invoke 超时 + 收尾余量）；客户端断开则提前放行。
            await Promise.race([
              followupDone,
              clientGone,
              new Promise<void>((resolve) => setTimeout(resolve, 660_000)),
            ]);
          }
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
    // 知音楼会话同步进工作台列表（channel 字段保留，前端用于标识渠道），便于排查 IM 侧问题。
    const items = (await store.listConversations())
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
      return context.json(publicView(redactRecord(conversation, redact)));
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
    }
  });

  // —— 调试面板：读取已落盘的 AI trace（模型输入/输出、工具调用原文）——
  type TraceManifestEntry = {
    ts: string;
    trace_id: string;
    message_id: string | null;
    file: string;
    summary?: Record<string, unknown>;
  };

  /** 会话时间线事件（events.jsonl 一行）：编排事实，与模型轮 trace 合并渲染。 */
  type TimelineEvent = {
    event_id: string;
    kind: string;
    at: string;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
  };

  const readTraceManifest = async (conversationId: string): Promise<TraceManifestEntry[] | null> => {
    if (!options.observabilityDir) return null;
    const dir = await findConversationObservabilityDir(options.observabilityDir, conversationId);
    if (!dir) return null;
    let raw: string;
    try {
      raw = await readFile(`${dir}/manifest.jsonl`, 'utf8');
    } catch {
      return null;
    }
    const entries: TraceManifestEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TraceManifestEntry;
        if (entry.trace_id && entry.file) entries.push(entry);
      } catch {
        // 跳过坏行
      }
    }
    return entries.reverse();
  };

  const readTimelineEvents = async (conversationId: string): Promise<TimelineEvent[]> => {
    if (!options.observabilityDir) return [];
    const dir = await findConversationObservabilityDir(options.observabilityDir, conversationId);
    if (!dir) return [];
    let raw: string;
    try {
      raw = await readFile(`${dir}/events.jsonl`, 'utf8');
    } catch {
      return [];
    }
    const events: TimelineEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as TimelineEvent;
        if (event.event_id && event.at && event.kind) events.push(event);
      } catch {
        // 跳过坏行
      }
    }
    return events;
  };

  // 会话时间线：trace（模型轮）与 event（编排事实）按时间合并，最新在前。
  routes.get('/conversations/:id/ai-traces', async (context) => {
    const conversationId = context.req.param('id');
    const [manifest, events] = await Promise.all([
      readTraceManifest(conversationId),
      readTimelineEvents(conversationId),
    ]);
    const traceEntries = (manifest ?? []).map(({ file: _file, ...entry }) => ({
      ...entry,
      entry_type: 'trace' as const,
    }));
    const eventEntries = events.map((event) => ({
      ts: event.at,
      trace_id: event.event_id,
      message_id: null,
      entry_type: 'event' as const,
      event_kind: event.kind,
      title: event.title,
    }));
    const merged = [...traceEntries, ...eventEntries].sort((a, b) => b.ts.localeCompare(a.ts));
    return context.json(merged);
  });

  routes.get('/conversations/:id/ai-traces/:traceId', async (context) => {
    const conversationId = context.req.param('id');
    const traceId = context.req.param('traceId');
    if (!/^[0-9a-zA-Z_-]{1,64}$/.test(traceId)) return jsonError('trace not found', 404);
    const entries = await readTraceManifest(conversationId);
    const entry = entries?.find((item) => item.trace_id === traceId);
    if (!entry) {
      // trace 清单里找不到时按时间线事件兜底（evt- 前缀）。
      const event = (await readTimelineEvents(conversationId)).find((item) => item.event_id === traceId);
      if (!event) return jsonError('trace not found', 404);
      return context.json({
        entry_type: 'event',
        conversation_id: conversationId,
        trace_id: event.event_id,
        captured_at: event.at,
        ...event,
      });
    }
    const fileName = entry.file.replace(/^traces\//, '');
    if (!/^[\w.-]+\.json$/.test(fileName)) return jsonError('trace not found', 404);
    const dir = await findConversationObservabilityDir(options.observabilityDir!, conversationId);
    try {
      const raw = await readFile(`${dir}/traces/${fileName}`, 'utf8');
      return context.json(JSON.parse(raw));
    } catch {
      return jsonError('trace not found', 404);
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
      if (parsed.data.title != null) conversation.title = parsed.data.title;
      if (parsed.data.model_override !== undefined) conversation.model_override = parsed.data.model_override || null;
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
      redactRecordInPlace(conversation, redact);
    } catch (error) {
      if (error instanceof ProductNotFoundError) return jsonError('conversation not found', 404);
      throw error;
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
      ownerSubject: context.get('identity')?.subject,
    });
  });

  return routes;
}
