/** Yach IM channel: CLI event inbound + diagnosis + CLI markdown outbound. */

import type { RuntimeConfig } from '../../config.js';
import type { CapabilityMcp } from '../../capabilities/mcp.js';
import type { DiagnosisAgent } from '../../diagnosis/agent.js';
import { runDiagnosisRound } from '../../diagnosis/run-round.js';
import type { ModelConfiguration } from '../../model/configuration.js';
import type { ProductStore } from '../../product/store.js';
import type { ConversationRecord } from '../../domain/schemas.js';
import { IM_MESSAGE_LIMIT, YachCli } from './cli.js';
import { buildGroupDiagnosisContent, summarizeGroupHistory } from './history.js';
import { yachHistory, yachInbound, yachInboundSkipped, yachOutbound } from './log.js';
import { InvalidYachEvent, parseYachEvent, peekWorkCode, type YachEvent } from './parse.js';

const DEDUPE_LIMIT = 4096;
const DEDUPE_TTL_MS = 15 * 60 * 1000;

interface EmployeeSession {
  queue: YachEvent[];
  running: boolean;
  conversationId: string | null;
  abort: AbortController | null;
}

function truncateReply(text: string, workbenchUrl: string): string {
  const suffix = `\n\n完整报告请打开工作台：${workbenchUrl}`;
  if (text.length + suffix.length <= IM_MESSAGE_LIMIT) {
    return `${text}${text.includes(workbenchUrl) ? '' : suffix}`;
  }
  const budget = Math.max(0, IM_MESSAGE_LIMIT - suffix.length - 20);
  return `${text.slice(0, budget).trimEnd()}\n\n…（已截断）${suffix}`;
}

export interface YachChannelDeps {
  config: RuntimeConfig;
  store: ProductStore;
  diagnosisAgent: DiagnosisAgent;
  capabilities: CapabilityMcp;
  modelConfiguration: ModelConfiguration;
}

export class YachChannel {
  private readonly cli: YachCli;
  private readonly sessions = new Map<string, EmployeeSession>();
  private readonly seen = new Map<string, number>();
  private readonly mapping = new Map<string, string>();
  private loop: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly deps: YachChannelDeps) {
    const { config } = deps;
    this.cli = new YachCli({
      cliPath: config.yachCliPath,
      appKey: config.yachAppKey,
      appSecret: config.yachAppSecret,
    });
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.consume();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.abort?.abort();
      session.queue = [];
    }
    await this.cli.close();
    if (this.loop) await this.loop.catch(() => undefined);
  }

  private workbenchUrl(): string {
    const { publicBaseUrl, appPrefix } = this.deps.config;
    if (!publicBaseUrl) return appPrefix || '/xesapp-agent';
    return `${publicBaseUrl}${appPrefix || '/xesapp-agent'}/`;
  }

  private mappingKey(event: YachEvent): string {
    if (event.groupId) {
      return `im:${this.deps.config.yachAppKey}:g:${event.groupId}:${event.workCode}`;
    }
    return `im:${this.deps.config.yachAppKey}:${event.workCode}`;
  }

  private sessionKey(event: YachEvent): string {
    return event.groupId ? `${event.workCode}:g:${event.groupId}` : event.workCode;
  }

  private sessionFor(event: YachEvent): EmployeeSession {
    const key = this.sessionKey(event);
    let session = this.sessions.get(key);
    if (!session) {
      session = { queue: [], running: false, conversationId: null, abort: null };
      this.sessions.set(key, session);
    }
    return session;
  }

  private rememberMessage(messageId: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.seen) {
      if (now - at > DEDUPE_TTL_MS) this.seen.delete(id);
    }
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, now);
    while (this.seen.size > DEDUPE_LIMIT) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
    return true;
  }

  private async reply(event: YachEvent, text: string): Promise<void> {
    try {
      await this.cli.sendMarkdown(event, text);
      yachOutbound(event, text, 'ok');
    } catch (error) {
      yachOutbound(event, text, 'error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async consume(): Promise<void> {
    for await (const payload of this.cli.events()) {
      if (this.closed) break;
      try {
        const event = parseYachEvent(payload);
        if (!this.rememberMessage(event.messageId)) {
          yachInboundSkipped('duplicate', { messageId: event.messageId });
          continue;
        }
        yachInbound(event);
        await this.enqueue(event);
      } catch (error) {
        if (error instanceof InvalidYachEvent) {
          let chat: string | undefined;
          try {
            const msg = payload && typeof payload === 'object'
              ? (payload as Record<string, unknown>)
              : {};
            const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : (msg.data ?? msg);
            if (data && typeof data === 'object') {
              chat = String((data as Record<string, unknown>).conversationType ?? '') === '2'
                ? 'group'
                : 'private';
            }
          } catch {
            // ignore
          }
          yachInboundSkipped(error.message, {
            chat,
            workCode: peekWorkCode(payload) ?? '(absent)',
          });
          continue;
        }
        yachInboundSkipped('handler_error', {
          error: error instanceof Error ? error.message : String(error),
          workCode: peekWorkCode(payload) ?? '(absent)',
        });
      }
    }
  }

  private async enqueue(event: YachEvent): Promise<void> {
    const session = this.sessionFor(event);
    if (event.text === '/stop') {
      session.abort?.abort();
      session.queue = [];
      try {
        await this.reply(event, '已停止当前诊断。');
      } catch {
        // ignore
      }
      return;
    }
    if (session.running) {
      if (event.text === '/new') {
        session.queue = [event];
        return;
      }
      if (session.queue.length >= 1) {
        try {
          await this.reply(event, '上一轮仍在诊断，请稍后再试。');
        } catch {
          // ignore
        }
        return;
      }
      session.queue.push(event);
      return;
    }
    session.running = true;
    void this.runSession(event);
  }

  private async runSession(first: YachEvent): Promise<void> {
    const session = this.sessionFor(first);
    let current: YachEvent | undefined = first;
    try {
      while (current && !this.closed) {
        await this.handleEvent(session, current);
        current = session.queue.shift();
      }
    } finally {
      session.running = false;
      session.abort = null;
      const next = session.queue.shift();
      if (next) {
        session.running = true;
        void this.runSession(next);
      }
    }
  }

  private async resolveConversation(
    session: EmployeeSession,
    event: YachEvent,
    forceNew: boolean,
  ): Promise<ConversationRecord> {
    const key = this.mappingKey(event);
    if (!forceNew) {
      const existingId = session.conversationId ?? this.mapping.get(key);
      if (existingId) {
        try {
          const existing = await this.deps.store.getConversation(existingId);
          session.conversationId = existing.id;
          this.mapping.set(key, existing.id);
          return existing;
        } catch {
          // create below
        }
      }
    }
    const title = event.groupId
      ? `IM群 · ${event.displayName || event.workCode}`
      : `IM · ${event.displayName || event.workCode}`;
    const created = await this.deps.store.createConversation({
      title,
      channel: 'yach_im',
      owner_subject: event.workCode,
    });
    session.conversationId = created.id;
    this.mapping.set(key, created.id);
    return created;
  }

  private async diagnosisContent(event: YachEvent): Promise<string> {
    if (!event.groupId) return event.text;
    try {
      const rows = await this.cli.groupHistory(event.groupId);
      const summary = summarizeGroupHistory(rows);
      yachHistory(event.groupId, rows.length, summary.length);
      if (!summary) {
        yachInboundSkipped('group_history_empty_summary', {
          groupId: event.groupId,
          rows: rows.length,
        });
      }
      return buildGroupDiagnosisContent(event.text, summary);
    } catch (error) {
      yachInboundSkipped('group_history_failed', {
        groupId: event.groupId,
        error: error instanceof Error ? error.message : String(error),
      });
      return event.text;
    }
  }

  private async handleEvent(session: EmployeeSession, event: YachEvent): Promise<void> {
    if (event.text === '/new') {
      await this.resolveConversation(session, event, true);
      await this.reply(event, '已开启新的诊断会话，请发送问题。');
      return;
    }

    if (!this.deps.modelConfiguration.enabled) {
      await this.reply(event, '诊断服务尚未配置模型，请先在网页工作台完成模型设置。');
      return;
    }

    const conversation = await this.resolveConversation(session, event, false);
    const abort = new AbortController();
    session.abort = abort;
    const content = await this.diagnosisContent(event);
    try {
      await this.reply(event, '已收到，正在诊断…');
    } catch {
      // non-blocking ack
    }
    try {
      const result = await runDiagnosisRound({
        store: this.deps.store,
        diagnosisAgent: this.deps.diagnosisAgent,
        capabilities: this.deps.capabilities,
        modelConfiguration: this.deps.modelConfiguration,
        conversation,
        content,
        abortSignal: abort.signal,
        options: {
          knowledgeQueryLog: this.deps.config.knowledgeQueryLog,
          caseArchiveDir: this.deps.config.caseArchiveDir,
        },
      });
      if (abort.signal.aborted) return;
      const body = result.terminal === 'completed'
        ? (result.text || '诊断完成，但没有生成正文。')
        : (result.assistantMessage.error || '诊断失败，请稍后重试或打开网页工作台。');
      await this.reply(event, truncateReply(body, this.workbenchUrl()));
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : '诊断运行失败';
      try {
        await this.reply(event, truncateReply(`诊断失败：${message}`, this.workbenchUrl()));
      } catch {
        // ignore
      }
    } finally {
      if (session.abort === abort) session.abort = null;
    }
  }
}

export function isYachImConfigured(
  config: Pick<RuntimeConfig, 'yachEnabled' | 'yachAppKey' | 'yachAppSecret'>,
): boolean {
  return Boolean(config.yachEnabled && config.yachAppKey.trim() && config.yachAppSecret.trim());
}
