import { createHash, createHmac, randomBytes } from 'node:crypto';

export const CLIENT_LOG_REDACTION_VERSION = 'client-log-v1';

export type LogIdentifierKind = 'learner_id' | 'phone' | 'trace_id' | 'request_id';
export type LogIdentifiers = Partial<Record<LogIdentifierKind, string>>;
export type MatchedIdentifier = { kind: LogIdentifierKind; matched: true };

const SECRET_KEY = /(?:token|secret|authorization|cookie|password|api[_-]?key)/i;
const IDENTITY_KEY = /^(?:uid|user_?id|student_?id|learner_?id|phone|mobile|device_?id|session_?id|trace_?id|request_?id|customtraceid)$/i;
const PHONE_PATTERN = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const ID_CARD_PATTERN = /(?<![A-Za-z0-9])\d{17}[\dXx](?![A-Za-z0-9])/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** 单轮密钥只存在内存中；跨轮不承诺伪名或日志证据 ID 可重放。 */
export class ClientLogPrivacy {
  private readonly key: Buffer;
  private readonly identifiers: Array<{ kind: LogIdentifierKind; value: string }>;

  constructor(identifiers: LogIdentifiers, key?: Buffer) {
    this.key = key ?? randomBytes(32);
    this.identifiers = Object.entries(identifiers)
      .filter((entry): entry is [LogIdentifierKind, string] => typeof entry[1] === 'string' && entry[1].length > 0)
      .map(([kind, value]) => ({ kind, value }))
      .sort((left, right) => right.value.length - left.value.length);
  }

  pseudonym(kind: string, value: string): string {
    const digest = createHmac('sha256', this.key).update(`${kind}\0${value}`).digest('hex').slice(0, 16);
    return `${kind}:${digest}`;
  }

  sanitize(value: unknown): { value: unknown; matched_identifiers: MatchedIdentifier[] } {
    const matched = new Set<LogIdentifierKind>();
    const sanitized = this.walk(value, '', matched, 0);
    return {
      value: sanitized,
      matched_identifiers: [...matched].sort().map((kind) => ({ kind, matched: true })),
    };
  }

  /** 助手回复、外发摘要等长文本只脱敏标识符和通用号码；500 字上限只适用于工具结果等结构化数据。 */
  sanitizeText(text: string): string {
    let value = text;
    for (const identifier of this.identifiers) {
      const pattern = new RegExp(
        `(?<![A-Za-z0-9])${escapeRegExp(identifier.value)}(?![A-Za-z0-9])`,
        'g',
      );
      if (pattern.test(value)) {
        pattern.lastIndex = 0;
        value = value.replace(pattern, this.pseudonym(identifier.kind, identifier.value));
      }
      pattern.lastIndex = 0;
    }
    return value
      .replace(BEARER_PATTERN, '[redacted-token]')
      .replace(PHONE_PATTERN, '[redacted-phone]')
      .replace(ID_CARD_PATTERN, '[redacted-id-card]');
  }

  entryId(value: unknown): string {
    const sanitized = this.sanitize(value).value;
    return `log-${createHash('sha256').update(JSON.stringify(canonical(sanitized))).digest('hex').slice(0, 24)}`;
  }

  /** 流式文本只暂扣敏感值前缀及可能未完成的通用号码，不延迟普通文本。 */
  sensitiveSuffixLength(text: string): number {
    let length = 0;
    for (const identifier of this.identifiers) {
      const limit = Math.min(identifier.value.length, text.length);
      for (let size = 1; size <= limit; size += 1) {
        if (text.endsWith(identifier.value.slice(0, size))) length = Math.max(length, size);
      }
    }
    const phoneSuffix = text.match(/(?:\+?86[- ]?)?1[3-9][\d\s-]{0,22}$/)?.[0].length ?? 0;
    const idCardSuffix = text.match(/\d{1,17}[\dXx]?$/)?.[0].length ?? 0;
    return Math.max(length, phoneSuffix, idCardSuffix);
  }

  private walk(value: unknown, keyName: string, matched: Set<LogIdentifierKind>, depth: number): unknown {
    if (depth > 12) return '[truncated-depth]';
    if (SECRET_KEY.test(keyName)) return '[redacted]';
    if (typeof value === 'string') {
      let text = value;
      let replacedIdentifier = false;
      for (const identifier of this.identifiers) {
        const pattern = new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(identifier.value)}(?![A-Za-z0-9])`,
          'g',
        );
        if (pattern.test(text)) {
          matched.add(identifier.kind);
          replacedIdentifier = true;
          pattern.lastIndex = 0;
          text = text.replace(pattern, this.pseudonym(identifier.kind, identifier.value));
        }
        pattern.lastIndex = 0;
      }
      if (IDENTITY_KEY.test(keyName) && !replacedIdentifier) {
        const kind = keyName.toLowerCase().replace(/[^a-z]/g, '_');
        return this.pseudonym(kind, value);
      }
      text = text
        .replace(BEARER_PATTERN, '[redacted-token]')
        .replace(PHONE_PATTERN, '[redacted-phone]')
        .replace(ID_CARD_PATTERN, '[redacted-id-card]');
      return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    }
    if (typeof value === 'number' && IDENTITY_KEY.test(keyName)) {
      const raw = String(value);
      for (const identifier of this.identifiers) {
        if (identifier.value === raw) matched.add(identifier.kind);
      }
      return this.pseudonym(keyName.toLowerCase().replace(/[^a-z]/g, '_'), raw);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => this.walk(item, '', matched, depth + 1));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 40)
          .map(([key, item]) => [key, this.walk(item, key, matched, depth + 1)]),
      );
    }
    return value;
  }
}
