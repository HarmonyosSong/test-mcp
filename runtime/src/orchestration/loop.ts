import type { DiagnosisTaskType } from '../domain/schemas.js';
import type {
  InvestigationPlan,
  RequestedInvestigationScope,
} from './plan.js';

export type LocalContinuationInput = {
  responsibility: 'client' | 'server' | 'shared' | 'unknown';
  taskType: DiagnosisTaskType;
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
  | { type: 'continue_external'; plan: InvestigationPlan }
  | { type: 'finish'; reason: string };

/**
 * 本地报告校验通过后，根据显式 next_action 决定是否请求统一外部全栈 Agent。
 * responsibility 只描述当前证据的责任判断，不再兼任路由条件。
 * 本地观测不再作为跨侧外发门槛：前端/服务端证据常需委派获取；缺少 traceId/requestId
 * 也不阻断外发——关联缺口由外发摘要显式声明，由外部 Agent 按学员标识与时间窗关联。
 */
export function decideLocalContinuation(
  current: InvestigationPlan,
  input: LocalContinuationInput,
): LocalContinuationDecision {
  if (current.mode !== 'local') {
    return { type: 'finish', reason: '当前不是本地起始计划，无需执行本地接续判断' };
  }
  if (!input.nextAction?.trim()) {
    return { type: 'finish', reason: '没有明确的外部协查问题和下一步路由' };
  }
  if (input.requestedScope === 'client') {
    return { type: 'finish', reason: '用户明确限定只查客户端' };
  }
  if (!input.compassEnabled) {
    return { type: 'finish', reason: '外部协查当前不可用，保留本地结论和缺口' };
  }
  if (input.budgetExpired || input.remoteCallsExhausted || input.handoffsExhausted) {
    return { type: 'finish', reason: '调查预算或 handoff 上限已耗尽，保留本地结论和缺口' };
  }

  const informationLookup = input.taskType === 'rule' || input.taskType === 'implementation';
  return {
    type: 'continue_external',
    plan: {
      ...current,
      mode: 'server',
      branches: ['server'],
      remoteSlots: ['compass'],
      externalScope: 'frontend_backend',
      clientSteps: [],
      correlationReady: input.correlationReady,
      reason: informationLookup
        ? `${input.taskType === 'implementation' ? '实现查询' : '规则查询'}需要统一外部全栈 Agent 继续核查；该路由不代表服务端责任已确认`
        : `本地报告请求统一外部全栈 Agent 继续调查；当前责任判断为 ${input.responsibility}`,
    },
  };
}
