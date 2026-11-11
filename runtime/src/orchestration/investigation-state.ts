import { DiagnosisReportSchema, type DiagnosisReport } from '../domain/schemas.js';
import type { InvestigationPlan } from './plan.js';

/** 持久化在 Conversation.investigation 中的可恢复调查快照。 */
export interface InvestigationStateSnapshot {
  version: 1;
  originalContent: string;
  userMessageId: string;
  initialPlan: InvestigationPlan;
  currentPlan: InvestigationPlan;
  planHistory: InvestigationPlan[];
  localReport: DiagnosisReport | null;
  localText: string;
  consultationId: string | null;
  remoteCallsUsed: number;
  handoffRoundsUsed: number;
}

export function createInvestigationStateSnapshot(input: {
  originalContent: string;
  userMessageId: string;
  plan: InvestigationPlan;
}): InvestigationStateSnapshot {
  return {
    version: 1,
    originalContent: input.originalContent,
    userMessageId: input.userMessageId,
    initialPlan: clonePlan(input.plan),
    currentPlan: clonePlan(input.plan),
    planHistory: [clonePlan(input.plan)],
    localReport: null,
    localText: '',
    consultationId: null,
    remoteCallsUsed: 0,
    handoffRoundsUsed: 0,
  };
}

export function readInvestigationStateSnapshot(value: unknown): InvestigationStateSnapshot {
  if (!isObject(value) || value.version !== 1) throw new Error('会话缺少可恢复的调查状态');
  if (typeof value.originalContent !== 'string' || typeof value.userMessageId !== 'string') {
    throw new Error('调查状态缺少原始用户消息');
  }
  if (!Array.isArray(value.planHistory) || value.planHistory.length === 0) {
    throw new Error('调查状态缺少计划历史');
  }
  if (value.localReport !== null && typeof value.localReport !== 'object') {
    throw new Error('调查状态中的本地报告无效');
  }
  if (typeof value.localText !== 'string') throw new Error('调查状态中的本地正文无效');
  if (value.consultationId !== null && typeof value.consultationId !== 'string') {
    throw new Error('调查状态中的咨询引用无效');
  }
  if (!isNonNegativeInteger(value.remoteCallsUsed) || !isNonNegativeInteger(value.handoffRoundsUsed)) {
    throw new Error('调查状态中的预算计数无效');
  }
  return {
    version: 1,
    originalContent: value.originalContent,
    userMessageId: value.userMessageId,
    initialPlan: readPlan(value.initialPlan),
    currentPlan: readPlan(value.currentPlan),
    planHistory: value.planHistory.map(readPlan),
    localReport: value.localReport === null ? null : DiagnosisReportSchema.parse(value.localReport),
    localText: value.localText,
    consultationId: value.consultationId,
    remoteCallsUsed: value.remoteCallsUsed,
    handoffRoundsUsed: value.handoffRoundsUsed,
  };
}

export function serializeInvestigationState(state: InvestigationStateSnapshot): Record<string, unknown> {
  return {
    ...state,
    initialPlan: clonePlan(state.initialPlan),
    currentPlan: clonePlan(state.currentPlan),
    planHistory: state.planHistory.map(clonePlan),
  };
}

export function appendPlanHistory(state: InvestigationStateSnapshot, plan: InvestigationPlan): void {
  const previous = state.planHistory.at(-1);
  if (previous && JSON.stringify(previous) === JSON.stringify(plan)) return;
  state.planHistory.push(clonePlan(plan));
}

function readPlan(value: unknown): InvestigationPlan {
  if (!isObject(value) || !['local', 'server', 'parallel'].includes(String(value.mode))) {
    throw new Error('调查计划无效');
  }
  if (!Array.isArray(value.branches) || value.branches.some((item) => item !== 'client' && item !== 'server')) {
    throw new Error('调查计划分支无效');
  }
  if (!Array.isArray(value.remoteSlots) || value.remoteSlots.some((item) => typeof item !== 'string')) {
    throw new Error('调查计划远端槽位无效');
  }
  const clientSteps = value.clientSteps === undefined
    ? (value.branches.includes('client') ? ['observe', 'source'] : [])
    : value.clientSteps;
  if (!Array.isArray(clientSteps) || clientSteps.some((item) => item !== 'observe' && item !== 'source')) {
    throw new Error('调查计划客户端阶段无效');
  }
  if ((!value.branches.includes('client') && clientSteps.length > 0)
      || (clientSteps.includes('source') && clientSteps[0] !== 'observe')) {
    throw new Error('调查计划客户端阶段顺序无效');
  }
  if (typeof value.reason !== 'string' || typeof value.correlationReady !== 'boolean') {
    throw new Error('调查计划理由或关联状态无效');
  }
  if (!isObject(value.budget) || typeof value.budget.maxSeconds !== 'number' ||
      !Number.isFinite(value.budget.maxSeconds) || value.budget.maxSeconds <= 0 ||
      !isNonNegativeInteger(value.budget.maxRemoteCalls)) {
    throw new Error('调查计划预算无效');
  }
  if (!isNonNegativeInteger(value.maxHandoffRounds)) throw new Error('调查计划 handoff 上限无效');
  return clonePlan({ ...value, clientSteps } as unknown as InvestigationPlan);
}

function clonePlan(plan: InvestigationPlan): InvestigationPlan {
  return {
    ...plan,
    branches: [...plan.branches],
    remoteSlots: [...plan.remoteSlots],
    clientSteps: [...plan.clientSteps],
    budget: { ...plan.budget },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
