import type { YachOAPI, YachSendTarget } from './oapi.js';

/** Append-only progress card; coalesces updates and never blocks the diagnosis run. */
export class YachProgressCard {
  private latest = '已收到问题，正在处理。';
  private finished = false;
  private changed = false;
  private readonly startedAt = Date.now();
  private readonly task: Promise<void>;
  private wake!: () => void;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly api: YachOAPI,
    private readonly target: YachSendTarget,
  ) {
    this.task = this.sendLoop();
  }

  update(text: string): void {
    if (this.finished || text === this.latest) return;
    this.latest = text;
    this.changed = true;
    this.wake?.();
  }

  async finish(text: string): Promise<void> {
    this.latest = text;
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

  private async sendLoop(): Promise<void> {
    let cardId: string | undefined;
    try {
      cardId = await Promise.race([
        this.api.createCard(this.target),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('create timeout')), 3_000)),
      ]);
      await Promise.race([
        this.api.pushCard(cardId, '**处理进度**\n\n已收到问题，正在处理。'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('push timeout')), 3_000)),
      ]);
      let delivered = '已收到问题，正在处理。';
      while (true) {
        await this.waitForChange();
        this.changed = false;
        if (!this.finished) await new Promise((resolve) => setTimeout(resolve, 1_000));
        const text = this.latest;
        const done = this.finished;
        if (text !== delivered) {
          const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
          await Promise.race([
            this.api.pushCard(cardId, `\n- ${text}（${elapsed} 秒）`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('push timeout')), 3_000)),
          ]);
          delivered = text;
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
