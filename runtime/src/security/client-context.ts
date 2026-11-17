import {
  extractClientIdentityFromMessages,
  extractCorrelationContext,
  type CorrelationContext,
} from '../orchestration/client-identity.js';
import { ClientLogPrivacy, type LogIdentifiers } from './log-privacy.js';

/** 仅使用用户原文构造本轮隐私上下文；assistant 输出不能注入新的匹配标识。 */
export function clientIdentifiersFromMessages(userTexts: readonly string[]): LogIdentifiers {
  const bounded = userTexts.slice(-20);
  const identity = extractClientIdentityFromMessages(bounded);
  const request = Object.assign({}, ...bounded.map(extractCorrelationContext)) as CorrelationContext;
  return {
    ...(identity.learnerId ? { learner_id: identity.learnerId } : {}),
    ...(identity.phone ? { phone: identity.phone } : {}),
    ...(request.traceId ? { trace_id: request.traceId } : {}),
    ...(request.requestId ? { request_id: request.requestId } : {}),
  };
}

export function createClientLogPrivacy(
  userTexts: readonly string[],
  includeRequestCorrelation = true,
): ClientLogPrivacy {
  const identifiers = clientIdentifiersFromMessages(userTexts);
  if (!includeRequestCorrelation) {
    delete identifiers.trace_id;
    delete identifiers.request_id;
  }
  return new ClientLogPrivacy(identifiers);
}

export function redactClientText(privacy: ClientLogPrivacy, text: string): string {
  return privacy.sanitizeText(text);
}
