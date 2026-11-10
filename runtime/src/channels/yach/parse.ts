/** Parse yach-cli event NDJSON into a normalized channel event. */

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
  conversationType: '1' | '2';
  remoteConversationId: string;
  groupId: string | null;
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

function employeeWorkCode(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    throw new InvalidYachEvent('missing employee workCode');
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvalidYachEvent(`invalid employee workCode type=${typeof value}`);
  }
  const workCode = String(value).trim();
  if (workCode === '-1') throw new InvalidYachEvent('bot message ignored');
  // TAL work codes may be pure digits or letter-prefixed (e.g. V0047863).
  if (!/^[A-Za-z0-9]{4,16}$/.test(workCode)) {
    throw new InvalidYachEvent(`invalid employee workCode="${workCode.slice(0, 32)}"`);
  }
  return workCode;
}

/** Best-effort extract of workCode from CLI event payloads (group frames vary). */
export function peekWorkCode(raw: unknown): string | undefined {
  try {
    const message = unwrapMessage(raw);
    const user = message.userJson ? asObject(message.userJson) : {};
    const candidates = [user.workCode, user.work_code, message.workCode, message.work_code];
    for (const value of candidates) {
      if (value === undefined || value === null || value === '') continue;
      return String(value).trim().slice(0, 32);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function pickId(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  throw new InvalidYachEvent('missing identifier');
}

function normalizeConversationType(value: unknown): '1' | '2' {
  const text = String(value ?? '').trim();
  if (text === '1' || text === '2') return text;
  throw new InvalidYachEvent('unsupported conversation type');
}

function unwrapMessage(raw: unknown): Record<string, unknown> {
  const envelope = asObject(raw);
  let message: unknown = envelope.data ?? envelope;
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message) as unknown;
    } catch {
      throw new InvalidYachEvent('invalid nested data');
    }
  }
  const body = asObject(message);
  // Rare TalMsg native text shape: { type, from, data, msg_id }
  if (typeof body.type === 'string' && body.type === 'text' && typeof body.data === 'string' && !body.msgtype) {
    return {
      msgtype: 'text',
      content: body.data,
      msgId: body.msg_id ?? body.msgId,
      senderUUid: body.from,
      senderId: body.from,
      conversationType: body.conversationType ?? '1',
      conversationId: body.conversationId,
      createAt: body.ts ?? body.createAt,
      userJson: body.userJson,
      event_type: body.event_type ?? envelope.event_type,
    };
  }
  return body;
}

export function parseYachEvent(raw: unknown): YachEvent {
  const message = unwrapMessage(raw);
  const kind = message.msgtype;
  if (kind !== 'text' && kind !== 'start_new_session' && kind !== 'reply') {
    throw new InvalidYachEvent('unsupported message type');
  }
  const conversationType = normalizeConversationType(message.conversationType);
  const created = message.createAt ?? message.ts;
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

  const senderRaw = typeof message.senderId === 'string' && message.senderId.includes('|')
    ? message.senderId.split('|').pop()
    : message.senderId;
  const senderId = pickId(message.senderUUid, senderRaw);
  const messageId = pickId(message.msgId, message.msg_id);
  const conversationId = pickId(
    message.conversationId,
    conversationType === '2' ? message.group_id : undefined,
  );
  const user = message.userJson ? asObject(message.userJson) : {};
  const workCode = employeeWorkCode(
    user.workCode ?? user.work_code ?? message.workCode ?? message.work_code,
  );
  const displayName = typeof user.name === 'string'
    ? user.name
    : (typeof message.senderNick === 'string' ? message.senderNick : '');

  let rawText = message.content;
  if (kind === 'reply' && (typeof rawText !== 'string' || !rawText.trim()) && typeof message.replyContent === 'string') {
    rawText = message.replyContent;
  }
  if (typeof rawText !== 'string' || Buffer.byteLength(rawText, 'utf8') > MAX_EVENT_BYTES / 2) {
    throw new InvalidYachEvent('invalid text');
  }
  const text = kind === 'start_new_session' ? '/new' : rawText.trim();
  if (!text) throw new InvalidYachEvent('empty message');

  const groupId = conversationType === '2' ? conversationId : null;
  return {
    workCode,
    displayName,
    messageId,
    senderId,
    text,
    toId: conversationType === '2' ? conversationId : senderId,
    conversationType,
    remoteConversationId: conversationId,
    groupId,
  };
}
