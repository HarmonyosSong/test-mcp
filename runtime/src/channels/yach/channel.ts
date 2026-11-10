import { resolve } from 'node:path';

import type { RuntimeConfig } from '../../config.js';
import type { CapabilityMcp } from '../../capabilities/mcp.js';
import type { DiagnosisAgent } from '../../diagnosis/agent.js';
import { runDiagnosisRound } from '../../diagnosis/run-round.js';
import type { ModelConfiguration } from '../../model/configuration.js';
import type { ProductStore } from '../../product/store.js';
import type { ConversationRecord } from '../../domain/schemas.js';
import { IM_MESSAGE_LIMIT, YachOAPI } from './oapi.js';
import { InvalidYachEvent, parseYachEvent, type YachEvent } from './parse.js';
import { YachProgressCard } from './progress.js';
import { progressLabelForStreamEvent } from './progress-map.js';
import { YachBridge } from './bridge.js';

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
  if (text.length + suffix.length <= IM_MESSAGE_LIMIT) return `${text}${text.includes(workbenchUrl) ? '' : suffix}`;
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
  private readonly api: YachOAPI;
  private readonly bridge: YachBridge;
  private readonly sessions = new Map<string, EmployeeSession>();
  private readonly seen = new Map<string, number>();
  private readonly mapping = new Map<string, string>();
  private loop: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly deps: YachChannelDeps) {
    const { config } = deps;
    this.api = new YachOAPI({
      baseUrl: config.yachBaseUrl,
      appKey: config.yachAppKey,
      appSecret: config.yachAppSecret,
      versionArea: config.yachVersionArea,
    });
    this.bridge = new YachBridge({
      appKey: config.yachAppKey,
      appSecret: config.yachAppSecret,
      channelAppId: config.yachChannelAppId,
      bizId: config.yachBizId,
      dispatchUrl: config.yachDispatchUrl,
      bridgePath: config.yachBridgePath,
      nodePath: config.yachNodePath,
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
    await this.bridge.close();
    if (this.loop) await this.loop.catch(() => undefined);
  }

  private workbenchUrl(): string {
    const { publicBaseUrl, appPrefix } = this.deps.config;
    if (!publicBaseUrl) return appPrefix || '/xesapp-agent';
    return `${publicBaseUrl}${appPrefix || '/xesapp-agent'}/`;
  }

  private mappingKey(workCode: string): string {
    return `im:${this.deps.config.yachAppKey}:${workCode}`;
  }

  private sessionFor(workCode: string): EmployeeSession {
    let session = this.sessions.get(workCode);
    if (!session) {
      session = { queue: [], running: false, conversationId: null, abort: null };
      this.sessions.set(workCode, session);
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

  private async consume(): Promise<void> {
    for await (const payload of this.bridge.events()) {
      if (this.closed) break;
      try {
        const event = parseYachEvent(payload, this.deps.config.yachAppKey);
        if (!this.rememberMessage(event.messageId)) continue;
        await this.enqueue(event);
      } catch (error) {
        if (!(error instanceof InvalidYachEvent)) {
          console.warn('Yach event handling failed', error instanceof Error ? error.message : error);
        }
      }
    }
  }

  private async enqueue(event: YachEvent): Promise<void> {
    const session = this.sessionFor(event.workCode);
    if (event.text === '/stop') {
      session.abort?.abort();
      session.queue = [];
      try {
        await this.api.sendMarkdown(event, '已停止当前诊断。');
      } catch {
        // ignore
      }
      return;
    }
    if (session.running) {
      // /new always takes the single queue slot; ordinary messages only if empty.
      if (event.text === '/new') {
        session.queue = [event];
        return;
      }
      if (session.queue.length >= 1) {
        try {
          await this.api.sendMarkdown(event, '上一轮仍在诊断，请稍后再试。');
        } catch {
          // ignore
        }
        return;
      }
      session.queue.push(event);
      return;
    }
    session.running = true;
    void this.runSession(event.workCode, event);
  }

  private async runSession(workCode: string, first: YachEvent): Promise<void> {
    const session = this.sessionFor(workCode);
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
        void this.runSession(workCode, next);
      }
    }
  }

  private async resolveConversation(session: EmployeeSession, event: YachEvent, forceNew: boolean): Promise<ConversationRecord> {
    const key = this.mappingKey(event.workCode);
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
    const created = await this.deps.store.createConversation({
      title: `IM · ${event.displayName || event.workCode}`,
      channel: 'yach_im',
      owner_subject: event.workCode,
    });
    session.conversationId = created.id;
    this.mapping.set(key, created.id);
    return created;
  }

  private async handleEvent(session: EmployeeSession, event: YachEvent): Promise<void> {
    if (event.text === '/new') {
      await this.resolveConversation(session, event, true);
      await this.api.sendMarkdown(event, '已开启新的诊断会话，请发送问题。');
      return;
    }

    if (!this.deps.modelConfiguration.enabled) {
      await this.api.sendMarkdown(event, '诊断服务尚未配置模型，请先在网页工作台完成模型设置。');
      return;
    }

    const conversation = await this.resolveConversation(session, event, false);
    const progress = new YachProgressCard(this.api, event);
    const abort = new AbortController();
    session.abort = abort;
    let sawText = false;
    try {
      const result = await runDiagnosisRound({
        store: this.deps.store,
        diagnosisAgent: this.deps.diagnosisAgent,
        capabilities: this.deps.capabilities,
        modelConfiguration: this.deps.modelConfiguration,
        conversation,
        content: event.text,
        abortSignal: abort.signal,
        options: {
          knowledgeQueryLog: this.deps.config.knowledgeQueryLog,
          caseArchiveDir: this.deps.config.caseArchiveDir,
        },
        onEvent: (streamEvent) => {
          const label = progressLabelForStreamEvent(streamEvent);
          if (!label) return;
          if (streamEvent.type === 'text') {
            if (sawText) return;
            sawText = true;
          }
          progress.update(label);
        },
      });
      // /stop already sent a confirmation; skip cancelled final markdown.
      if (abort.signal.aborted) {
        await progress.finish('已取消');
        return;
      }
      await progress.finish(result.terminal === 'completed' ? '诊断完成' : '诊断失败');
      const body = result.terminal === 'completed'
        ? (result.text || '诊断完成，但没有生成正文。')
        : (result.assistantMessage.error || '诊断失败，请稍后重试或打开网页工作台。');
      await this.api.sendMarkdown(event, truncateReply(body, this.workbenchUrl()));
    } catch (error) {
      if (abort.signal.aborted) {
        await progress.finish('已取消');
        return;
      }
      await progress.finish('诊断失败');
      const message = error instanceof Error ? error.message : '诊断运行失败';
      try {
        await this.api.sendMarkdown(event, truncateReply(`诊断失败：${message}`, this.workbenchUrl()));
      } catch {
        // ignore
      }
    } finally {
      if (session.abort === abort) session.abort = null;
    }
  }
}

export function defaultYachBridgePath(projectRoot: string): string {
  return resolve(projectRoot, 'runtime/yach-bridge/bridge.cjs');
}

export function isYachImConfigured(config: Pick<RuntimeConfig, 'yachEnabled' | 'yachAppKey' | 'yachAppSecret'>): boolean {
  return Boolean(config.yachEnabled && config.yachAppKey.trim() && config.yachAppSecret.trim());
}
