import { hasRequestCorrelation } from './correlation.js';
import { matchServerSignals, type ServerSignals } from './server-signals.js';

export type InvestigationMode = 'local' | 'server' | 'parallel';
export type InvestigationBranch = 'client' | 'server';
export type ClientInvestigationStep = 'observe' | 'source';
export type RequestedInvestigationScope = 'client' | 'server';

export type CorrelationContext = {
  traceId?: string;
  requestId?: string;
  occurredAt?: string;
  serviceOrEndpoint?: string;
};

export type InvestigationBudget = {
  maxSeconds: number;
  maxRemoteCalls: number;
};

export type InvestigationPlan = {
  mode: InvestigationMode;
  branches: InvestigationBranch[];
  remoteSlots: string[];
  clientSteps: ClientInvestigationStep[];
  reason: string;
  correlationReady: boolean;
  budget: InvestigationBudget;
  maxHandoffRounds: number;
};

export type InvestigationPlanInput = {
  question: string;
  repositoryBound: boolean;
  hasLocalEvidence: boolean;
  hasLogObservation: boolean;
  requestedScope?: RequestedInvestigationScope;
  compassEnabled: boolean;
  correlation?: CorrelationContext;
  budget: InvestigationBudget;
  maxHandoffRounds?: number;
  // 多端接入前保留该上下文，但不参与分流。
  clientPlatform?: 'harmony';
};

export function createInvestigationPlan(
  input: InvestigationPlanInput,
  signals: ServerSignals,
): InvestigationPlan {
  assertValidBudget(input.budget);
  const maxHandoffRounds = input.maxHandoffRounds ?? 1;
  if (!Number.isInteger(maxHandoffRounds) || maxHandoffRounds < 0) {
    throw new Error('maxHandoffRounds 必须是非负整数');
  }

  const correlationReady = hasRequestCorrelation(input.correlation);
  const remoteAvailable = input.compassEnabled && input.budget.maxRemoteCalls > 0;
  const base = {
    correlationReady,
    budget: { ...input.budget },
    maxHandoffRounds,
    clientSteps: input.repositoryBound
      ? ['observe', 'source'] as ClientInvestigationStep[]
      : ['observe'] as ClientInvestigationStep[],
  };

  if (input.requestedScope === 'client') {
    return localPlan(base, '用户明确限定只查客户端');
  }
  if (input.requestedScope === 'server') {
    return remoteAvailable
      ? serverPlan(base, '用户明确指定只查服务端')
      : localPlan(base, '用户指定服务端，但外部协查未启用或远端预算已耗尽');
  }
  if (!input.repositoryBound && !input.hasLocalEvidence) {
    return localPlan(base, '会话未绑定仓库且无本地证据，先走知识或澄清路径');
  }

  const signal = matchServerSignals(input.question, signals);
  if (signal.matched && correlationReady && remoteAvailable && !input.hasLogObservation) {
    return localPlan(base, `命中服务端特征（${signal.labels.join('、')}），但尚无本地日志观测，先确认现场再决定协查`);
  }
  if (signal.matched && correlationReady && remoteAvailable) {
    return {
      ...base,
      mode: 'parallel',
      branches: ['client', 'server'],
      remoteSlots: ['compass'],
      reason: `已有本地日志观测，且命中服务端特征（${signal.labels.join('、')}）并具备请求关联标识`,
    };
  }
  if (signal.matched && !correlationReady) {
    return localPlan(base, `命中服务端特征（${signal.labels.join('、')}），但缺少 traceId 或请求 ID`);
  }
  if (signal.matched && !remoteAvailable) {
    return localPlan(base, '命中服务端特征，但外部协查未启用或远端预算已耗尽');
  }
  return localPlan(base, '缺少足够的服务端信号，先进行本地调查');
}

type PlanBase = Pick<
  InvestigationPlan,
  'correlationReady' | 'budget' | 'maxHandoffRounds' | 'clientSteps'
>;

function localPlan(base: PlanBase, reason: string): InvestigationPlan {
  return { ...base, mode: 'local', branches: ['client'], remoteSlots: [], reason };
}

function serverPlan(base: PlanBase, reason: string): InvestigationPlan {
  return { ...base, mode: 'server', branches: ['server'], remoteSlots: ['compass'], clientSteps: [], reason };
}

function assertValidBudget(budget: InvestigationBudget): void {
  if (!Number.isFinite(budget.maxSeconds) || budget.maxSeconds <= 0) {
    throw new Error('maxSeconds 必须是正数');
  }
  if (!Number.isInteger(budget.maxRemoteCalls) || budget.maxRemoteCalls < 0) {
    throw new Error('maxRemoteCalls 必须是非负整数');
  }
}
