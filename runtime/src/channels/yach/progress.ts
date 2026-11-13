import type { DiagnosisStreamEvent } from '../../diagnosis/agent.js';
import type { YachSendTarget } from './cli.js';
import {
  applyProgressEvent,
  createProgressChecklist,
  PROGRESS_STEPS,
  type ProgressChecklist,
  type ProgressStepId,
} from './progress-map.js';

export interface YachCardApi {
  createCard(target: YachSendTarget): Promise<string>;
  pushCard(cardId: string, content: string): Promise<void>;
  closeCard(cardId: string): Promise<void>;
}

function initialBody(): string {
  const lines = ['**任务进度**', '', '已完成 0/5 项', ''];
  for (const step of PROGRESS_STEPS) lines.push(`○ ${step.title}`);
  lines.push('', '- 已收到问题，正在处理（0 秒）');
  return lines.join('\n');
}

/**
 * 追加式进度卡：先发完整计划，再按工具事件追加 ✓ / 状态行。
 * 失败只吞掉，不阻断终态 markdown。
 */
export class YachProgressCard {
  private checklist: ProgressChecklist = createProgressChecklist();
  private latestLabel: string | null = '已收到问题，正在处理';
  private finished = false;
  private changed = false;
  private readonly startedAt = Date.now();
  private readonly task: Promise<void>;
  private wake!: () => void;
  private waiters: Array<() => void> = [];
  private announcedDone = new Set<ProgressStepId>();
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
    const before = { ...this.checklist };
    const applied = applyProgressEvent(this.checklist, event);
    this.checklist = applied.checklist;
    if (applied.label) this.latestLabel = applied.label;

    for (const step of PROGRESS_STEPS) {
      if (before[step.id] !== 'done' && this.checklist[step.id] === 'done' && !this.announcedDone.has(step.id)) {
        this.announcedDone.add(step.id);
        this.pendingLines.push(`✓ ${step.title}`);
      }
    }
    if (applied.label && applied.label !== this.lastAnnouncedLabel) {
      this.lastAnnouncedLabel = applied.label;
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      this.pendingLines.push(`- ${applied.label}（${elapsed} 秒）`);
    }

    if (this.pendingLines.length > 0 || applied.changed) {
      this.changed = true;
      this.wake?.();
    }
  }

  update(text: string): void {
    if (this.finished || text === this.latestLabel) return;
    this.latestLabel = text;
    if (text !== this.lastAnnouncedLabel) {
      this.lastAnnouncedLabel = text;
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      this.pendingLines.push(`- ${text}（${elapsed} 秒）`);
    }
    this.changed = true;
    this.wake?.();
  }

  async finish(text: string): Promise<void> {
    const done = PROGRESS_STEPS.filter((step) => this.checklist[step.id] === 'done').length;
    this.pendingLines.push('', `**${text}** · 已完成 ${done}/5 项`);
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
      this.lastAnnouncedLabel = '已收到问题，正在处理';

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
