export type ClientIdentity = {
  learnerId?: string;
  phone?: string;
};

const LEARNER_PATTERN = /(?:学员(?:编号|ID|id)|student[_ -]?id|learner[_ -]?id|uid)\s*(?:为|是)?\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{1,63})/gi;
const PHONE_PATTERN = /(?:联系电话|联系手机|手机号|手机号码|phone(?:\s*number)?)\s*(?:为|是)?\s*[:：=]?\s*(\+?\d[\d\s-]{4,24}\d)/gi;

/** 只从带明确标签的用户原文提取身份，避免把任意数字误当成学员标识。 */
export function extractClientIdentity(text: string): ClientIdentity {
  const bounded = text.slice(0, 20_000);
  const learner = LEARNER_PATTERN.exec(bounded)?.[1]?.trim();
  LEARNER_PATTERN.lastIndex = 0;
  const phoneMatch = PHONE_PATTERN.exec(bounded)?.[1];
  PHONE_PATTERN.lastIndex = 0;
  const phone = phoneMatch
    ? phoneMatch.replace(/[\s-]/g, '')
    : undefined;
  return {
    ...(learner ? { learnerId: learner } : {}),
    ...(phone && /^\+?\d{5,20}$/.test(phone) ? { phone } : {}),
  };
}

export function hasClientIdentity(identity: ClientIdentity): boolean {
  return Boolean(identity.learnerId || identity.phone);
}

/** 同一字段以最近一次明确输入为准；不同字段可跨用户消息合并，assistant 文本不参与。 */
export function extractClientIdentityFromMessages(messages: readonly string[]): ClientIdentity {
  const resolved: ClientIdentity = {};
  for (const message of [...messages].reverse()) {
    const current = extractClientIdentity(message);
    if (!resolved.learnerId && current.learnerId) resolved.learnerId = current.learnerId;
    if (!resolved.phone && current.phone) resolved.phone = current.phone;
    if (resolved.learnerId && resolved.phone) break;
  }
  return resolved;
}
