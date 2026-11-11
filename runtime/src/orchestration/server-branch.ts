import type { RemoteConclusion } from '../domain/schemas.js';
import type { AgentSlotRegistry, RemoteAgentSlot } from './agent-slot-registry.js';
import type { Branch, BranchContext, BranchResult } from './supervisor.js';
import type { InvestigationPlan } from './plan.js';
import {
  markExternalConsultationSent,
  transitionExternalConsultation,
  type ExternalConsultation,
} from './consultation.js';

export type CompassServerBranchData = {
  remoteConclusion: RemoteConclusion;
  consultation: ExternalConsultation;
};

export type CompassServerBranchOptions = {
  consultation: ExternalConsultation;
  onConsultationUpdate: (consultation: ExternalConsultation) => Promise<void>;
  onAudit?: (audit: {
    operation: 'invoke' | 'cancel';
    slotId: string;
    taskId: string | null;
    state: string | null;
    durationMs: number;
    truncated: boolean;
  }) => Promise<void>;
};

export class CompassServerBranch implements Branch {
  private consultation: ExternalConsultation;
  private slot: RemoteAgentSlot | null = null;
  private context: BranchContext | null = null;
  private taskId: string | null = null;

  public constructor(
    private readonly registry: AgentSlotRegistry,
    private readonly options: CompassServerBranchOptions,
  ) {
    this.consultation = options.consultation;
  }

  public async run(_plan: InvestigationPlan, context: BranchContext): Promise<BranchResult> {
    if (this.consultation.status !== 'approved') {
      return { branch: 'server', status: 'skipped', error: '服务端咨询尚未批准' };
    }
    if (!context.capabilityContext) throw new Error('服务端分支缺少 CapabilityContext');
    this.context = context;
    const capabilityContext = {
      ...context.capabilityContext,
      abortSignal: context.abortSignal,
    };
    this.slot = await this.registry.resolve('compass', capabilityContext);
    this.consultation = markExternalConsultationSent(this.consultation);
    // 发送检查点落库之前不得产生任何远端 HTTP。
    await this.options.onConsultationUpdate(this.consultation);

    try {
      const result = await this.registry.invoke(this.slot, {
        text: this.consultation.outbound_text,
        contextId: this.consultation.context_id ?? undefined,
      }, capabilityContext);
      const data = parseCompassResult(result.data);
      this.taskId = data.taskId;
      if (result.audit) {
        await this.options.onAudit?.({
          operation: 'invoke',
          slotId: String(result.audit.slotId ?? this.slot.slotId),
          taskId: typeof result.audit.taskId === 'string' ? result.audit.taskId : data.taskId,
          state: typeof result.audit.state === 'string' ? result.audit.state : data.state,
          durationMs: Number(result.audit.durationMs ?? 0),
          truncated: Boolean(result.audit.truncated ?? result.truncated),
        });
      }
      const completed = data.state === 'TASK_STATE_COMPLETED';
      this.consultation = transitionExternalConsultation(this.consultation, completed ? 'completed' : 'failed', {
        taskId: data.taskId,
        contextId: data.contextId,
      });
      const remoteConclusion: RemoteConclusion = {
        consultation_id: this.consultation.id,
        task_id: data.taskId,
        context_id: data.contextId,
        agent_id: this.slot.slotId,
        agent_version: null,
        state: data.state,
        text: data.text,
        truncated: result.truncated,
        scope: ['current_question', 'correlation'],
        limitations: result.limitations,
        request_digest: this.consultation.outbound_digest,
        received_at: new Date().toISOString(),
      };
      await this.options.onConsultationUpdate(this.consultation);
      return {
        branch: 'server',
        status: completed ? 'completed' : 'failed',
        data: { remoteConclusion, consultation: this.consultation } satisfies CompassServerBranchData,
        ...(!completed ? { error: '远端 Agent 未完成调查' } : {}),
      };
    } catch (error) {
      this.consultation = transitionExternalConsultation(this.consultation, 'unknown', {
        taskId: this.taskId,
      });
      await this.options.onConsultationUpdate(this.consultation);
      return {
        branch: 'server',
        status: context.abortSignal.aborted ? 'cancelled' : 'failed',
        error: context.abortSignal.aborted ? '服务端调查已取消，远端状态待确认' : '服务端调查失败，远端状态待确认',
      };
    }
  }

  public async cancel(_reason: string): Promise<void> {
    if (!this.slot || !this.taskId || !this.context?.capabilityContext) return;
    const context = {
      ...this.context.capabilityContext,
      // 取消清理不复用已 abort 的调查信号。
      abortSignal: undefined,
    };
    await this.registry.cancel(this.slot, this.taskId, context);
    this.consultation = transitionExternalConsultation(this.consultation, 'cancel_requested', {
      taskId: this.taskId,
    });
    await this.options.onConsultationUpdate(this.consultation);
  }
}

function parseCompassResult(value: unknown): {
  text: string;
  taskId: string | null;
  contextId: string | null;
  state: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Slot 返回结构无效');
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') throw new Error('Slot 返回缺少文本结论');
  return {
    text: record.text,
    taskId: typeof record.taskId === 'string' ? record.taskId : null,
    contextId: typeof record.contextId === 'string' ? record.contextId : null,
    state: typeof record.state === 'string' ? record.state : null,
  };
}
