import type { CorrelationContext } from './plan.js';

export function hasRequestCorrelation(context: CorrelationContext | undefined): boolean {
  return Boolean(context?.traceId?.trim() || context?.requestId?.trim());
}

/** 只提取明确标记的 ID；订单号等普通数字不能冒充请求关联标识。 */
export function extractCorrelationContext(question: string): CorrelationContext {
  const traceId = /(?:\btrace[_ -]?id)\s*[:=：]\s*([A-Za-z0-9._-]{1,128})/i.exec(question)?.[1];
  const requestId = /(?:\brequest[_ -]?id|请求\s*ID)\s*[:=：]\s*([A-Za-z0-9._-]{1,128})/i.exec(question)?.[1];
  return {
    ...(traceId ? { traceId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
