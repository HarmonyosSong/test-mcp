/** 本轮成功查到的模拟登录 Token，供渠道出站后处理（QR/COS）读取；不注册为模型工具。 */

export type SimulationLoginTokenHit = {
  uid: string;
  token: string;
};

const byMessageId = new Map<string, SimulationLoginTokenHit[]>();

export function recordSimulationLoginToken(messageId: string, hit: SimulationLoginTokenHit): void {
  const token = hit.token.trim();
  const uid = hit.uid.trim();
  if (!messageId || !token || !uid) return;
  const list = byMessageId.get(messageId) ?? [];
  if (list.some((item) => item.uid === uid && item.token === token)) {
    byMessageId.set(messageId, list);
    return;
  }
  list.push({ uid, token });
  byMessageId.set(messageId, list);
}

/** 取出并清除，避免跨轮误用。 */
export function takeSimulationLoginTokens(messageId: string): SimulationLoginTokenHit[] {
  const list = byMessageId.get(messageId) ?? [];
  byMessageId.delete(messageId);
  return list;
}

export function peekSimulationLoginTokens(messageId: string): readonly SimulationLoginTokenHit[] {
  return byMessageId.get(messageId) ?? [];
}

export function clearSimulationLoginTokens(messageId: string): void {
  byMessageId.delete(messageId);
}
