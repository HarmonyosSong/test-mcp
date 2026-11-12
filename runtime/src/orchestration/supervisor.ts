import { InvestigationBudgetTracker } from './budget.js';
import type { DiagnosisTaskType } from '../domain/schemas.js';
import type { CapabilityContext } from '../capabilities/session.js';
import { decideLocalContinuation } from './loop.js';
import type {
  InvestigationBranch,
  InvestigationPlan,
  RequestedInvestigationScope,
} from './plan.js';

export type BranchStatus = 'completed' | 'failed' | 'cancelled' | 'skipped';

export type BranchResult = {
  branch: InvestigationBranch;
  status: BranchStatus;
  responsibility?: 'client' | 'server' | 'shared' | 'unknown';
  taskType?: DiagnosisTaskType;
  nextAction?: string;
  hasObservedEvidence?: boolean;
  data?: unknown;
  error?: string;
};

export type BranchContext = {
  abortSignal: AbortSignal;
  requestedScope?: RequestedInvestigationScope;
  compassEnabled: boolean;
  capabilityContext?: Omit<CapabilityContext, 'abortSignal'> & { abortSignal?: AbortSignal };
};

export interface Branch {
  run(plan: InvestigationPlan, context: BranchContext): Promise<BranchResult>;
  cancel(reason: string): Promise<void>;
}

export type SupervisorRunInput = {
  plan: InvestigationPlan;
  branches: Record<InvestigationBranch, Branch>;
  context: Omit<BranchContext, 'abortSignal'> & { abortSignal?: AbortSignal };
  approveRemote: (plan: InvestigationPlan) => Promise<boolean>;
  onBranchStatus?: (branch: InvestigationBranch, status: BranchStatus) => void | Promise<void>;
};

export type SupervisorRunResult = {
  status: 'completed' | 'failed' | 'cancelled';
  results: BranchResult[];
  planHistory: InvestigationPlan[];
  budget: ReturnType<InvestigationBudgetTracker['snapshot']>;
  reason?: string;
};

/** 确定性 fan-out/fan-in；分支只执行调查，路由、授权和预算由这里统一控制。 */
export class RuntimeSupervisor {
  public async run(input: SupervisorRunInput): Promise<SupervisorRunResult> {
    const tracker = new InvestigationBudgetTracker(input.plan.budget, input.plan.maxHandoffRounds);
    const controller = new AbortController();
    const parentSignal = input.context.abortSignal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('调查预算已到期')),
      tracker.remainingMs(),
    );
    const context: BranchContext = { ...input.context, abortSignal: controller.signal };
    const planHistory = [input.plan];

    const runBranch = async (
      branchName: InvestigationBranch,
      plan: InvestigationPlan,
    ): Promise<BranchResult> => {
      if (context.abortSignal.aborted) return { branch: branchName, status: 'cancelled' };
      const branch = input.branches[branchName];
      const cancel = () => {
        void branch.cancel(context.abortSignal.aborted ? '调查取消或预算到期' : '调查已停止').catch(() => undefined);
      };
      context.abortSignal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await branch.run(plan, context);
        await input.onBranchStatus?.(branchName, result.status);
        return result;
      } catch (error) {
        const status = context.abortSignal.aborted ? 'cancelled' : 'failed';
        const result = {
          branch: branchName,
          status,
          error: error instanceof Error ? error.message : '分支执行失败',
        } satisfies BranchResult;
        await input.onBranchStatus?.(branchName, status);
        return result;
      } finally {
        context.abortSignal.removeEventListener('abort', cancel);
      }
    };

    const runServer = async (plan: InvestigationPlan): Promise<BranchResult> => {
      if (!tracker.tryConsumeRemoteCall()) {
        return { branch: 'server', status: 'skipped', error: '远端调用预算已耗尽或调查已到期' };
      }
      const approved = await input.approveRemote(plan);
      if (!approved) return { branch: 'server', status: 'skipped', error: '未获外发授权' };
      if (context.abortSignal.aborted) return { branch: 'server', status: 'cancelled' };
      return runBranch('server', plan);
    };

    let results: BranchResult[] = [];
    let reason: string | undefined;
    try {
      if (input.plan.mode === 'parallel') {
        // 先启动客户端，再让授权与远端分支独立推进，授权等待不阻塞本地调查。
        const client = runBranch('client', input.plan);
        const server = runServer(input.plan);
        results = await Promise.all([client, server]);
      } else if (input.plan.mode === 'server') {
        results = [await runServer(input.plan)];
      } else {
        const local = await runBranch('client', input.plan);
        results = [local];
        if (local.status === 'completed' && !context.abortSignal.aborted) {
          const usage = tracker.snapshot();
          const decision = decideLocalContinuation(input.plan, {
            responsibility: local.responsibility ?? 'unknown',
            taskType: local.taskType ?? 'unknown',
            nextAction: local.nextAction,
            hasObservedEvidence: local.hasObservedEvidence === true,
            requestedScope: input.context.requestedScope,
            compassEnabled: input.context.compassEnabled,
            correlationReady: input.plan.correlationReady,
            budgetExpired: tracker.isExpired(),
            remoteCallsExhausted: usage.remoteCallsUsed >= input.plan.budget.maxRemoteCalls,
            handoffsExhausted: usage.handoffRoundsUsed >= input.plan.maxHandoffRounds,
          });
          if (decision.type === 'continue_external' && tracker.tryConsumeHandoff()) {
            planHistory.push(decision.plan);
            results.push(await runServer(decision.plan));
          } else if (decision.type === 'finish') {
            reason = decision.reason;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }

    const status = context.abortSignal.aborted
      ? 'cancelled'
      : results.some((result) => result.status === 'completed')
        ? 'completed'
        : results.some((result) => result.status === 'skipped')
          ? 'completed'
          : 'failed';
    return { status, results, planHistory, budget: tracker.snapshot(), ...(reason ? { reason } : {}) };
  }
}
