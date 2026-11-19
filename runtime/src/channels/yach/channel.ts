/** Yach IM channel: CLI event inbound + diagnosis + CLI markdown outbound. */

import type { RuntimeConfig } from '../../config.js';
import type { CapabilityMcp } from '../../capabilities/mcp.js';
import type { DiagnosisAgent } from '../../diagnosis/agent.js';
import { runDiagnosisRound, type RunDiagnosisRoundOptions } from '../../diagnosis/run-round.js';
import { parseVerdictMarker, trimToVerdictAnchor } from '../../diagnosis/final-answer-validator.js';
import type { ModelConfiguration } from '../../model/configuration.js';
import type { ProductStore } from '../../product/store.js';
import type { ConversationRecord } from '../../domain/schemas.js';
import { IM_MESSAGE_LIMIT, YachCli } from './cli.js';
import { buildGroupDiagnosisContent, summarizeGroupHistory } from './history.js';
import { yachHistory, yachInbound, yachInboundSkipped, yachOutbound } from './log.js';
import { InvalidYachEvent, parseYachEvent, peekWorkCode, type YachEvent } from './parse.js';
import { YachProgressCard } from './progress.js';

const DEDUPE_LIMIT = 4096;
const DEDUPE_TTL_MS = 15 * 60 * 1000;

interface EmployeeSession {
  queue: YachEvent[];
  running: boolean;
  conversationId: string | null;
  abort: AbortController | null;
}

function truncateReply(text: string): string {
  if (text.length <= IM_MESSAGE_LIMIT) return text;
  const budget = Math.max(0, IM_MESSAGE_LIMIT - 20);
  return `${text.slice(0, budget).trimEnd()}\n\n…（已截断）`;
}

/**
 * 知音楼最终回复：直接使用经校验的最终回答文本（首行「判定：」锚点即结论标签）。
 * 锚点缺失说明该文本未通过校验约定，只发兜底句，避免放出未校验内容。
 */
/** 锚点后的正文达到此长度才裁掉锚点前文本：避免把「结论正文+句尾锚点」式回复裁成只剩锚点。 */
const MIN_ANCHOR_BODY_CHARS = 120;

export function formatYachFinalReply(text: string | null | undefined): string {
  // 累计文本可能以模型步骤播报开头（工具间叙述）；锚点后正文足够长（模板化结论）
  // 时裁掉播报段，只发判定锚点起的最终结论。
  let body = text?.trim() ?? '';
  const trimmed = trimToVerdictAnchor(body);
  if (trimmed !== body && trimmed.length >= MIN_ANCHOR_BODY_CHARS) body = trimmed;
  if (!body || !parseVerdictMarker(body)) {
    return truncateReply('诊断已完成，请打开工作台查看详情。');
  }
  return truncateReply(body);
}

export interface YachChannelDeps {
  config: RuntimeConfig;
  store: ProductStore;
  diagnosisAgent: DiagnosisAgent;
  capabilities: CapabilityMcp;
  modelConfiguration: ModelConfiguration;
  /** 与网页诊断共用：缺省时 IM 会走 legacy 路径，无法自动 Compass A2A。 */
  diagnosisOptions?: RunDiagnosisRoundOptions;
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
      const summary = summarizeGroupHistory(rows, {
        excludeSenders: this.deps.config.yachBotName.split(',').map((name) => name.trim()).filter(Boolean),
      });
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
    const progress = new YachProgressCard(this.cli, event);
    const abort = new AbortController();
    session.abort = abort;
    const content = await this.diagnosisContent(event);
    let sawText = false;
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
          ...this.deps.diagnosisOptions,
        },
        onEvent: (streamEvent) => {
          if (streamEvent.type === 'text') {
            if (sawText) return;
            sawText = true;
          }
          // 本地分支可能在 A2A 联合阶段前完成；不能让进度卡提前宣布整轮诊断结束。
          if (streamEvent.type === 'completed' || streamEvent.type === 'failed') return;
          progress.onStreamEvent(streamEvent);
        },
      });
      // /stop 已发确认；取消时只关进度卡，不再发终态正文。
      if (abort.signal.aborted) {
        await progress.finish('已取消');
        return;
      }
      progress.onStreamEvent(result.terminal === 'completed'
        ? {
          type: 'completed',
          text: result.text,
          report: result.assistantMessage.report,
          verdict: null,
          evidence_state: result.conversation.evidence_state,
          messages_state: result.conversation.messages_state,
          input_tokens: result.assistantMessage.input_tokens ?? null,
          output_tokens: result.assistantMessage.output_tokens ?? null,
          tool_usage: {},
        }
        : {
          type: 'failed',
          error: result.assistantMessage.error || '诊断失败',
          failure_category: 'runtime_error',
          evidence_state: result.conversation.evidence_state,
          input_tokens: result.assistantMessage.input_tokens ?? null,
          output_tokens: result.assistantMessage.output_tokens ?? null,
          tool_usage: {},
        });
      await progress.finish(result.terminal === 'completed' ? '诊断完成' : '诊断失败');
      const body = result.terminal === 'completed'
        ? formatYachFinalReply(result.text)
        // 失败原因可能含堆栈/路径等内部细节，不进群消息；服务端已落日志。
        : '诊断失败：服务调用异常，请稍后重试或打开网页工作台。';
      await this.reply(event, body);
    } catch (error) {
      if (abort.signal.aborted) {
        await progress.finish('已取消');
        return;
      }
      await progress.finish('诊断失败');
      // 内部错误细节（含堆栈/本机路径的原始报错）不外泄到群——群聊历史会被再次注入 prompt。
      // 细节已由 yachOutbound/服务端日志记录。
      try {
        await this.reply(event, truncateReply('诊断失败：服务调用异常，请稍后重试'));
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
