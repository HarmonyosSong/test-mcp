import type { DiagnosisStreamEvent } from '../../diagnosis/agent.js';
import type { YachSendTarget } from './cli.js';
import { progressLabelForStreamEvent } from './progress-map.js';

export interface YachCardApi {
  createCard(target: YachSendTarget): Promise<string>;
  pushCard(cardId: string, content: string): Promise<void>;
  closeCard(cardId: string): Promise<void>;
}

const INITIAL_LABEL = '已收到问题，正在处理';

/** 进度卡首屏只有一句动态状态，不再预置固定任务清单。 */
function initialBody(): string {
  return `- ${INITIAL_LABEL}（0 秒）`;
}

/**
 * 追加式进度卡：只推送随诊断事件产生的动态状态行，不展示固定任务清单。
 * 失败只吞掉，不阻断终态 markdown。
 */
export class YachProgressCard {
  private latestLabel: string | null = INITIAL_LABEL;
  private finished = false;
  private changed = false;
  private readonly startedAt = Date.now();
  private readonly task: Promise<void>;
  private wake!: () => void;
  private waiters: Array<() => void> = [];
  private lastAnnouncedLabel: string | null = null;
  private pendingLines: string[] = [];

  constructor(
    private readonly api: YachCardApi,
    private readonly target: YachSendTarget,
  ) {
    this.task = this.sendLoop();
  }

  onStreamEvent(event: DiagnosisStreamEvent): void {
    if (this.finished) return;
    const label = progressLabelForStreamEvent(event);
    if (label) this.update(label);
  }

  update(text: string): void {
    if (this.finished || text === this.latestLabel) return;
    this.latestLabel = text;
    if (text !== this.lastAnnouncedLabel) {
      this.lastAnnouncedLabel = text;
      this.pendingLines.push(`- ${text}（${this.elapsedSeconds()} 秒）`);
    }
    this.changed = true;
    this.wake?.();
  }

  async finish(text: string): Promise<void> {
    this.pendingLines.push('', `**${text}**（耗时 ${this.elapsedSeconds()} 秒）`);
    this.latestLabel = text;
    this.finished = true;
    this.changed = true;
    this.wake?.();
    try {
      await Promise.race([
        this.task,
        new Promise((_, reject) => setTimeout(() => reject(new Error('progress timeout')), 5_000)),
      ]);
    } catch {
      // Card failures must not block the final answer.
    }
  }

  private elapsedSeconds(): number {
    return Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
  }

  private notifyWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForChange(): Promise<void> {
    if (this.changed || this.finished) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.wake = () => this.notifyWaiters();
    });
  }

  private takePending(): string {
    if (this.pendingLines.length === 0) return '';
    const chunk = `\n${this.pendingLines.join('\n')}`;
    this.pendingLines = [];
    return chunk;
  }

  private async sendLoop(): Promise<void> {
    let cardId: string | undefined;
    try {
      cardId = await Promise.race([
        this.api.createCard(this.target),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('create timeout')), 3_000)),
      ]);
      await Promise.race([
        this.api.pushCard(cardId, initialBody()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('push timeout')), 3_000)),
      ]);
      this.lastAnnouncedLabel = INITIAL_LABEL;

      while (true) {
        await this.waitForChange();
        this.changed = false;
        if (!this.finished) await new Promise((resolve) => setTimeout(resolve, 1_000));
        const chunk = this.takePending();
        const done = this.finished;
        if (chunk.trim()) {
          await Promise.race([
            this.api.pushCard(cardId, chunk),
            new Promise((_, reject) => setTimeout(() => reject(new Error('push timeout')), 3_000)),
          ]);
        }
        if (done) break;
      }
    } catch {
      // Swallow: final markdown reply is independent.
    } finally {
      if (cardId) {
        try {
          await Promise.race([
            this.api.closeCard(cardId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 3_000)),
          ]);
        } catch {
          // ignore
        }
      }
    }
  }
}
