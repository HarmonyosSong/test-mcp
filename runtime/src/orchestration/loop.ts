import type {
  InvestigationPlan,
  RequestedInvestigationScope,
} from './plan.js';

export type LocalContinuationInput = {
  responsibility: 'client' | 'server' | 'shared' | 'unknown';
  nextAction?: string;
  hasObservedEvidence: boolean;
  requestedScope?: RequestedInvestigationScope;
  compassEnabled: boolean;
  correlationReady: boolean;
  budgetExpired: boolean;
  remoteCallsExhausted: boolean;
  handoffsExhausted: boolean;
};

export type LocalContinuationDecision =
  | { type: 'continue_server'; plan: InvestigationPlan }
  | { type: 'needs_user_facts'; reason: string }
  | { type: 'finish'; reason: string };

/** 本地报告校验通过后，决定是否自动接续服务端；该函数不读取自由文本来猜测路由。 */
export function decideLocalContinuation(
  current: InvestigationPlan,
  input: LocalContinuationInput,
): LocalContinuationDecision {
  if (current.mode !== 'local') {
    return { type: 'finish', reason: '当前不是本地起始计划，无需执行本地接续判断' };
  }
  if (input.responsibility !== 'server' && input.responsibility !== 'shared') {
    return { type: 'finish', reason: '本地报告没有明确的跨侧路由' };
  }
  if (!input.nextAction?.trim()) {
    return { type: 'finish', reason: '跨侧路由缺少明确的下一步调查问题' };
  }
  if (!input.hasObservedEvidence) {
    return { type: 'finish', reason: '跨侧路由没有本地源码或日志观测支撑，保留为未验证线索' };
  }
  if (input.requestedScope === 'client') {
    return { type: 'finish', reason: '用户明确限定只查客户端' };
  }
  if (!input.compassEnabled) {
    return { type: 'finish', reason: '服务端协查开关未开启，保留本地结论和缺口' };
  }
  if (!input.correlationReady) {
    return { type: 'needs_user_facts', reason: '需要补充可关联本次故障的 traceId 或请求 ID' };
  }
  if (input.budgetExpired || input.remoteCallsExhausted || input.handoffsExhausted) {
    return { type: 'finish', reason: '调查预算或 handoff 上限已耗尽，保留本地结论和缺口' };
  }

  return {
    type: 'continue_server',
    plan: {
      ...current,
      mode: 'server',
      branches: ['server'],
      remoteSlots: ['compass'],
      clientSteps: [],
      correlationReady: true,
      reason: `本地报告的初步路由为 ${input.responsibility}，自动接续服务端调查`,
    },
  };
}
