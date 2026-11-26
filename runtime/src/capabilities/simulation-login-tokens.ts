/** 本轮成功查到的模拟登录 Token，供渠道出站后处理（QR/COS）读取；不注册为模型工具。 */

export type SimulationLoginTokenHit = {
  uid: string;
  token: string;
};

type Entry = {
  hits: SimulationLoginTokenHit[];
  updatedAt: number;
};

/** 条目最长驻留：诊断轮失败/中断时出站后处理不会取走，靠 TTL 惰性清理防进程级泄漏。 */
const ENTRY_TTL_MS = 30 * 60 * 1000;

const byMessageId = new Map<string, Entry>();

function sweepExpired(now: number): void {
  for (const [messageId, entry] of byMessageId) {
    if (now - entry.updatedAt > ENTRY_TTL_MS) byMessageId.delete(messageId);
  }
}

export function recordSimulationLoginToken(messageId: string, hit: SimulationLoginTokenHit): void {
  const token = hit.token.trim();
  const uid = hit.uid.trim();
  if (!messageId || !token || !uid) return;
  const now = Date.now();
  sweepExpired(now);
  const entry = byMessageId.get(messageId) ?? { hits: [], updatedAt: now };
  entry.updatedAt = now;
  if (!entry.hits.some((item) => item.uid === uid && item.token === token)) {
    entry.hits.push({ uid, token });
  }
  byMessageId.set(messageId, entry);
}

/** 取出并清除，避免跨轮误用。 */
export function takeSimulationLoginTokens(messageId: string): SimulationLoginTokenHit[] {
  sweepExpired(Date.now());
  const entry = byMessageId.get(messageId);
  byMessageId.delete(messageId);
  return entry?.hits ?? [];
}

export function peekSimulationLoginTokens(messageId: string): readonly SimulationLoginTokenHit[] {
  return byMessageId.get(messageId)?.hits ?? [];
}

export function clearSimulationLoginTokens(messageId: string): void {
  byMessageId.delete(messageId);
}
