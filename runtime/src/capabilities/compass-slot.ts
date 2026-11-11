import type {
  AgentSlotAdapter,
  CapabilityContext,
  CapabilityResult,
  RemoteAgentSlot,
} from '../orchestration/agent-slot-registry.js';
import type { CompassA2AProgress, CompassA2AResult } from './compass-a2a.js';

/** 结构化注入而非具体类，便于离线 mock；凭证只能留在 client 内部。 */
export type CompassSlotClient = {
  sendStreamingMessage(input: {
    text: string;
    contextId?: string;
    messageId?: string;
    onProgress?: (progress: CompassA2AProgress) => void;
    onPartialResult?: (result: CompassA2AResult) => void;
    abortSignal?: AbortSignal;
  }): Promise<CompassA2AResult>;
  cancelTask(taskId: string, signal?: AbortSignal): Promise<void>;
};

export type CompassSlotTask = {
  text: string;
  contextId?: string;
};

export type CompassSlotErrorCode =
  | 'invalid_slot'
  | 'invalid_task'
  | 'invalid_task_id'
  | 'external_timeout'
  | 'external_unknown';

export class CompassSlotError extends Error {
  public constructor(readonly code: CompassSlotErrorCode, message: string) {
    super(message);
    this.name = 'CompassSlotError';
  }
}

export type CompassSlotAudit = {
  operation: 'invoke' | 'cancel';
  slotId: string;
  taskId: string | null;
  state: string | null;
  durationMs: number;
  truncated: boolean;
};

export type CompassSlotAdapterOptions = {
  now?: () => number;
  cancelTimeoutMs?: number;
  onAudit?: (audit: CompassSlotAudit) => void;
};

/** Compass 结果仅是 external_findings 输入，不持有或调用 EvidenceLedger。 */
export class CompassSlotAdapter implements AgentSlotAdapter {
  private readonly now: () => number;
  private readonly cancelTimeoutMs?: number;
  private readonly onAudit?: (audit: CompassSlotAudit) => void;

  public constructor(
    private readonly client: CompassSlotClient,
    options: CompassSlotAdapterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cancelTimeoutMs = options.cancelTimeoutMs;
    this.onAudit = options.onAudit;
  }

  public async invoke(
    slot: RemoteAgentSlot,
    task: unknown,
    context: CapabilityContext,
  ): Promise<CapabilityResult> {
    assertInvocableSlot(slot);
    const input = parseTask(task);
    const externalSignal = context.abortSignal;
    externalSignal?.throwIfAborted();

    const startedAt = this.now();
    const controller = new AbortController();
    let latestTaskId: string | null = null;
    // 回调赋值发生在流式读取期间，使用引用避免控制流分析把它误缩成 null。
    const partialResult: { current: CompassA2AResult | null } = { current: null };
    let timeoutFired = false;
    let audit: CompassSlotAudit | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onExternalAbort: (() => void) | undefined;

    try {
      const sending = Promise.resolve().then(() => this.client.sendStreamingMessage({
        text: input.text,
        contextId: input.contextId,
        messageId: context.messageId,
        abortSignal: controller.signal,
        onProgress: (progress) => {
          if (progress.taskId?.trim()) latestTaskId = progress.taskId.trim();
        },
        onPartialResult: (partial) => {
          partialResult.current = partial;
          latestTaskId = normalizeTaskId(partial.taskId) ?? latestTaskId;
        },
      }));
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timeoutFired = true;
          controller.abort();
          reject(new CompassSlotError(
            'external_timeout',
            `Compass slot timed out after ${slot.timeoutMs}ms`,
          ));
        }, slot.timeoutMs);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (!externalSignal) return;
        onExternalAbort = () => {
          controller.abort();
          reject(createAbortError());
        };
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      });
      const result = await Promise.race([sending, deadline, aborted]);
      latestTaskId = normalizeTaskId(result.taskId) ?? latestTaskId;
      const truncated = result.text.length > slot.maxOutputChars;
      const limitations: string[] = [];
      if (truncated) limitations.push('remote_output_truncated_by_max_output_chars');
      if (result.state !== 'TASK_STATE_COMPLETED') {
        limitations.push(`remote_not_completed:${result.state ?? 'unknown'}`);
      }
      audit = {
        operation: 'invoke',
        slotId: slot.slotId,
        taskId: latestTaskId,
        state: result.state,
        durationMs: this.elapsed(startedAt),
        truncated,
      };
      return {
        data: {
          text: truncated ? result.text.slice(0, slot.maxOutputChars) : result.text,
          taskId: latestTaskId,
          contextId: result.contextId,
          state: result.state,
        } satisfies CompassA2AResult,
        truncated,
        limitations,
        audit: capabilityAudit(audit),
      };
    } catch (error) {
      const timedOut = timeoutFired || hasErrorCode(error, 'timeout');
      const aborted = Boolean(externalSignal?.aborted) || hasErrorCode(error, 'aborted');
      if (timedOut || aborted) {
        if (latestTaskId) await this.bestEffortCancel(slot, latestTaskId);
        const partial = partialResult.current;
        if (partial?.text) {
          // 中断不代表远端进入 cancelled；只保留实际观测到的状态和半截文本。
          const outputTruncated = partial.text.length > slot.maxOutputChars;
          audit = {
            operation: 'invoke',
            slotId: slot.slotId,
            taskId: latestTaskId,
            state: partial.state,
            durationMs: this.elapsed(startedAt),
            truncated: true,
          };
          return {
            data: {
              text: partial.text.slice(0, slot.maxOutputChars),
              taskId: latestTaskId,
              contextId: partial.contextId,
              state: partial.state,
            } satisfies CompassA2AResult,
            truncated: true,
            limitations: [
              timedOut ? 'remote_invocation_timeout' : 'remote_invocation_aborted',
              'remote_partial_result',
              ...(outputTruncated ? ['remote_output_truncated_by_max_output_chars'] : []),
            ],
            audit: capabilityAudit(audit),
          };
        }
        if (timedOut) {
          throw new CompassSlotError(
            'external_timeout',
            `Compass slot timed out after ${slot.timeoutMs}ms`,
          );
        }
        throw createAbortError();
      }
      // 不把上游原始错误文本写入工具结果或审计。
      throw new CompassSlotError('external_unknown', 'Compass slot invocation failed');
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onExternalAbort) externalSignal?.removeEventListener('abort', onExternalAbort);
      audit ??= {
        operation: 'invoke',
        slotId: slot.slotId,
        taskId: latestTaskId,
        state: 'unknown',
        durationMs: this.elapsed(startedAt),
        truncated: false,
      };
      this.onAudit?.(audit);
    }
  }

  public async cancel(
    slot: RemoteAgentSlot,
    taskId: string,
    _context: CapabilityContext,
  ): Promise<void> {
    assertInvocableSlot(slot);
    const normalizedTaskId = normalizeTaskId(taskId);
    if (!normalizedTaskId) {
      throw new CompassSlotError('invalid_task_id', 'Compass task id is required');
    }
    const startedAt = this.now();
    let state = 'unknown';
    try {
      await this.requestCancel(slot, normalizedTaskId);
      // CancelTask 已请求不代表远端已确认进入 cancelled。
      state = 'cancel_requested';
    } finally {
      this.onAudit?.({
        operation: 'cancel',
        slotId: slot.slotId,
        taskId: normalizedTaskId,
        state,
        durationMs: this.elapsed(startedAt),
        truncated: false,
      });
    }
  }

  private async bestEffortCancel(slot: RemoteAgentSlot, taskId: string): Promise<void> {
    const startedAt = this.now();
    let state = 'unknown';
    try {
      await this.requestCancel(slot, taskId);
      state = 'cancel_requested';
    } catch {
      // 保留原始 timeout/abort 分类，清理失败不能把远端状态伪造成 cancelled。
    } finally {
      this.onAudit?.({
        operation: 'cancel',
        slotId: slot.slotId,
        taskId,
        state,
        durationMs: this.elapsed(startedAt),
        truncated: false,
      });
    }
  }

  private async requestCancel(slot: RemoteAgentSlot, taskId: string): Promise<void> {
    // 不使用已经 abort 的轮次信号；清理有独立、有限的超时。
    const controller = new AbortController();
    const timeoutMs = this.cancelTimeoutMs ?? Math.min(slot.timeoutMs, 5_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelling = Promise.resolve().then(() => this.client.cancelTask(taskId, controller.signal));
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new CompassSlotError('external_unknown', 'Compass cancellation is unconfirmed'));
        }, timeoutMs);
      });
      await Promise.race([cancelling, deadline]);
    } catch {
      throw new CompassSlotError('external_unknown', 'Compass cancellation is unconfirmed');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }
}

function parseTask(task: unknown): CompassSlotTask {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new CompassSlotError('invalid_task', 'Compass task must be an object');
  }
  const record = task as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'text' && key !== 'contextId')) {
    throw new CompassSlotError('invalid_task', 'Compass task contains unsupported fields');
  }
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new CompassSlotError('invalid_task', 'Compass task text is required');
  }
  if (record.contextId !== undefined &&
      (typeof record.contextId !== 'string' || !record.contextId.trim())) {
    throw new CompassSlotError('invalid_task', 'Compass task contextId must be non-empty');
  }
  return {
    text: record.text.trim(),
    contextId: typeof record.contextId === 'string' ? record.contextId.trim() : undefined,
  };
}

function assertInvocableSlot(slot: RemoteAgentSlot): void {
  if (!Number.isFinite(slot.timeoutMs) || slot.timeoutMs <= 0 ||
      !Number.isInteger(slot.maxOutputChars) || slot.maxOutputChars <= 0 ||
      slot.evidenceMode !== 'external_findings') {
    throw new CompassSlotError('invalid_slot', 'Compass slot configuration is invalid');
  }
}

function normalizeTaskId(taskId: string | null): string | null {
  return typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' &&
    (error as { code?: unknown }).code === code);
}

function createAbortError(): DOMException {
  return new DOMException('Compass slot invocation aborted', 'AbortError');
}

function capabilityAudit(audit: CompassSlotAudit): NonNullable<CapabilityResult['audit']> {
  return {
    slotId: audit.slotId,
    taskId: audit.taskId,
    state: audit.state,
    durationMs: audit.durationMs,
    truncated: audit.truncated,
  };
}
