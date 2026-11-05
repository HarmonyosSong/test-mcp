import { createDecipheriv } from 'node:crypto';

const MAX_EVENT_BYTES = 256 * 1024;

export class InvalidYachEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidYachEvent';
  }
}

export interface YachEvent {
  workCode: string;
  displayName: string;
  messageId: string;
  senderId: string;
  text: string;
  toId: string;
  conversationType: '1';
  remoteConversationId: string;
}

function asObject(value: unknown): Record<string, unknown> {
  let current = value;
  if (typeof current === 'string') {
    if (Buffer.byteLength(current, 'utf8') > MAX_EVENT_BYTES) throw new InvalidYachEvent('event too large');
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      throw new InvalidYachEvent('invalid object');
    }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new InvalidYachEvent('expected object');
  }
  return current as Record<string, unknown>;
}

export function decryptIdentifier(value: unknown, appKey: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new InvalidYachEvent('invalid encrypted identifier');
  }
  try {
    const encrypted = Buffer.from(value, 'base64');
    if (!encrypted.length || encrypted.length % 16 !== 0) throw new Error('block size');
    const key = Buffer.from(appKey.slice(0, 16).padEnd(16, '\0'), 'utf8');
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const result = padded.toString('utf8');
    if (!result || result.length > 512 || [...result].some((ch) => ch.charCodeAt(0) < 32)) {
      throw new Error('identifier shape');
    }
    return result;
  } catch {
    throw new InvalidYachEvent('identifier decryption failed');
  }
}

function employeeWorkCode(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidYachEvent('missing or invalid employee identity');
  const workCode = value.trim();
  if (!/^\d{4,12}$/.test(workCode)) throw new InvalidYachEvent('missing or invalid employee identity');
  return workCode;
}

/** Accept only private-chat events from the authenticated SDK pipe. */
export function parseYachEvent(raw: unknown, appKey: string): YachEvent {
  const envelope = asObject(raw);
  const message = asObject(envelope.data ?? envelope);
  const kind = message.msgtype;
  if (kind !== 'text' && kind !== 'start_new_session') {
    throw new InvalidYachEvent('unsupported message type');
  }
  if (message.conversationType !== '1') {
    throw new InvalidYachEvent('unsupported conversation type');
  }
  const created = message.createAt;
  try {
    if (typeof created === 'boolean') throw new Error('timestamp type');
    let timestamp = Number(created);
    if (!Number.isFinite(timestamp)) throw new Error('timestamp');
    if (timestamp > 10 ** 11) timestamp /= 1000;
    const skew = Date.now() / 1000 - timestamp;
    if (skew < -120 || skew > 600) throw new Error('expired');
  } catch {
    throw new InvalidYachEvent('invalid timestamp');
  }
  const senderId = decryptIdentifier(message.senderId, appKey);
  const messageId = decryptIdentifier(message.msgId, appKey);
  const conversationId = decryptIdentifier(message.conversationId, appKey);
  const user = asObject(message.userJson);
  const workCode = employeeWorkCode(user.workCode);
  const displayName = typeof user.name === 'string' ? user.name : '';
  const rawText = message.content;
  if (typeof rawText !== 'string' || Buffer.byteLength(rawText, 'utf8') > MAX_EVENT_BYTES / 2) {
    throw new InvalidYachEvent('invalid text');
  }
  const text = kind === 'start_new_session' ? '/new' : rawText.trim();
  if (!text) throw new InvalidYachEvent('empty message');
  return {
    workCode,
    displayName,
    messageId,
    senderId,
    text,
    toId: senderId,
    conversationType: '1',
    remoteConversationId: conversationId,
  };
}
