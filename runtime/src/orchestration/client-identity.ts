export type ClientIdentity = {
  learnerId?: string;
  /** card = 学员编号；uid = 日志检索用的学员 uid。 */
  learnerIdSource?: 'card' | 'uid';
  phone?: string;
};

const CARD_PATTERN = /(?:学员(?:编号|ID|id)|student[_ -]?id|learner[_ -]?id)\s*(?:为|是)?\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{1,63})/gi;
const UID_PATTERN = /(?:\buid)\s*(?:为|是)?\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{1,63})/gi;
/** 「用户17524748 / 该用户 / 改用户」（口语，含常见错别字）后的纯数字。 */
const USER_NUMBER_PATTERN = /(?:该|改)?用户\s*[:：]?\s*(\d{6,20})/gi;
const PHONE_PATTERN = /(?:联系电话|联系手机|手机号|手机号码|phone(?:\s*number)?)\s*(?:为|是)?\s*[:：=]?\s*(\+?\d[\d\s-]{4,24}\d)/gi;

/** ≥11 位纯数字更像学员编号；更短的更像日志 uid。 */
function classifyNumericLearnerId(value: string): 'card' | 'uid' {
  return /^\d{11,20}$/.test(value) ? 'card' : 'uid';
}

/** 只从带明确标签或「用户+数字」的用户原文提取身份，避免把任意数字误当成学员标识。 */
export function extractClientIdentity(text: string): ClientIdentity {
  const bounded = text.slice(0, 20_000);
  const card = CARD_PATTERN.exec(bounded)?.[1]?.trim();
  CARD_PATTERN.lastIndex = 0;
  const uid = UID_PATTERN.exec(bounded)?.[1]?.trim();
  UID_PATTERN.lastIndex = 0;
  const userNumber = USER_NUMBER_PATTERN.exec(bounded)?.[1]?.trim();
  USER_NUMBER_PATTERN.lastIndex = 0;
  const phoneMatch = PHONE_PATTERN.exec(bounded)?.[1];
  PHONE_PATTERN.lastIndex = 0;
  const phone = phoneMatch
    ? phoneMatch.replace(/[\s-]/g, '')
    : undefined;
  // 明确「学员编号」优先；否则 uid 标签；再否则口语「用户+数字」。
  const learner = card
    ? { learnerId: card, learnerIdSource: 'card' as const }
    : uid
      ? { learnerId: uid, learnerIdSource: 'uid' as const }
      : userNumber
        ? { learnerId: userNumber, learnerIdSource: classifyNumericLearnerId(userNumber) }
        : {};
  return {
    ...learner,
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
    if (!resolved.learnerId && current.learnerId) {
      resolved.learnerId = current.learnerId;
      resolved.learnerIdSource = current.learnerIdSource;
    }
    if (!resolved.phone && current.phone) resolved.phone = current.phone;
    if (resolved.learnerId && resolved.phone) break;
  }
  return resolved;
}

/** 请求级关联标识（原 orchestration/correlation，编排路由已退役，提取逻辑保留供日志关联）。 */
export type CorrelationContext = {
  traceId?: string;
  requestId?: string;
};

/** 只提取明确标记的 ID；订单号等普通数字不能冒充请求关联标识。 */
export function extractCorrelationContext(question: string): CorrelationContext {
  const traceId = /(?:\btrace[_ -]?id)\s*[:=：]\s*([A-Za-z0-9._-]{1,128})/i.exec(question)?.[1];
  const requestId = /(?:\brequest[_ -]?id|请求\s*ID)\s*[:=：]\s*([A-Za-z0-9._-]{1,128})/i.exec(question)?.[1];
  return {
    ...(traceId ? { traceId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
