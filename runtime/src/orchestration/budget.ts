import type { InvestigationBudget } from './plan.js';

export type InvestigationBudgetSnapshot = {
  deadlineAt: number;
  remoteCallsUsed: number;
  handoffRoundsUsed: number;
};

/** 一个调查流程共享的预算计数器；远端分支和 handoff 不得各自另算额度。 */
export class InvestigationBudgetTracker {
  readonly deadlineAt: number;
  private remoteCallsUsed = 0;
  private handoffRoundsUsed = 0;

  public constructor(
    private readonly budget: InvestigationBudget,
    private readonly maxHandoffRounds: number,
    startedAt = Date.now(),
  ) {
    this.deadlineAt = startedAt + budget.maxSeconds * 1000;
  }

  public remainingMs(now = Date.now()): number {
    return Math.max(0, this.deadlineAt - now);
  }

  public isExpired(now = Date.now()): boolean {
    return this.remainingMs(now) === 0;
  }

  public tryConsumeRemoteCall(now = Date.now()): boolean {
    if (this.isExpired(now) || this.remoteCallsUsed >= this.budget.maxRemoteCalls) return false;
    this.remoteCallsUsed += 1;
    return true;
  }

  public tryConsumeHandoff(now = Date.now()): boolean {
    if (this.isExpired(now) || this.handoffRoundsUsed >= this.maxHandoffRounds) return false;
    this.handoffRoundsUsed += 1;
    return true;
  }

  public snapshot(): InvestigationBudgetSnapshot {
    return {
      deadlineAt: this.deadlineAt,
      remoteCallsUsed: this.remoteCallsUsed,
      handoffRoundsUsed: this.handoffRoundsUsed,
    };
  }
}
