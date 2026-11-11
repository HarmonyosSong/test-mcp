import { randomUUID } from 'node:crypto';

export type RunAdmissionRequest = {
  conversationId: string;
  runId?: string;
};

export type RunAdmissionGrant = {
  conversationId: string;
  runId: string;
};

export type RunAdmissionResult =
  | { ok: true; grant: RunAdmissionGrant }
  | { ok: false; reason: 'conversation_busy' | 'global_busy' };

/** 多进程部署时由 LibSQL lease 实现替换；调用方不依赖进程内 Map。 */
export interface RunAdmission {
  acquire(request: RunAdmissionRequest): Promise<RunAdmissionResult>;
  release(runId: string): Promise<void>;
  /** IM 排队等待任意准入释放；Web 不使用该等待，也不自动重试。 */
  waitForChange(signal?: AbortSignal): Promise<void>;
}

export class InMemoryRunAdmission implements RunAdmission {
  private readonly conversations = new Map<string, string>();
  private readonly runs = new Map<string, string>();
  private readonly waiters = new Set<() => void>();

  public constructor(private readonly maxConcurrentRuns: number) {
    if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns <= 0) {
      throw new Error('maxConcurrentRuns 必须是正整数');
    }
  }

  public async acquire(request: RunAdmissionRequest): Promise<RunAdmissionResult> {
    if (this.conversations.has(request.conversationId)) {
      return { ok: false, reason: 'conversation_busy' };
    }
    if (this.runs.size >= this.maxConcurrentRuns) {
      return { ok: false, reason: 'global_busy' };
    }

    const runId = request.runId ?? `run-${randomUUID()}`;
    if (this.runs.has(runId)) throw new Error(`runId 已存在: ${runId}`);
    // 无 await 的检查与写入在单进程内原子完成。
    this.conversations.set(request.conversationId, runId);
    this.runs.set(runId, request.conversationId);
    return { ok: true, grant: { conversationId: request.conversationId, runId } };
  }

  public async release(runId: string): Promise<void> {
    const conversationId = this.runs.get(runId);
    if (!conversationId) return;
    this.runs.delete(runId);
    this.conversations.delete(conversationId);
    for (const notify of this.waiters) notify();
  }

  public async waitForChange(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  public get activeRunCount(): number {
    return this.runs.size;
  }
}
