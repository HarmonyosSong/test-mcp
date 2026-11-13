import { createHash } from 'node:crypto';

export const CLIENT_LOG_REDACTION_VERSION = 'client-log-v1';

export type LogIdentifierKind = 'learner_id' | 'phone' | 'trace_id' | 'request_id';
export type LogIdentifiers = Partial<Record<LogIdentifierKind, string>>;
export type MatchedIdentifier = { kind: LogIdentifierKind; matched: true };

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

/**
 * 隐私上下文（2026-11-13 起不脱敏）。
 *
 * 用户决定：全链路内网协作排查，uid/电话/凭证等一律明文流转与落盘，
 * 本类不再做任何遮蔽或伪名化，只保留两件事：
 * 1. 结构限界（深度/条目数/单串长度），防止证据账本体积失控；
 * 2. matched_identifiers 观测元数据（记录日志里出现了哪些已登记标识），
 *    供 observation_context 与关联分析使用。
 * 类名与 API 保持稳定，便于未来需要时恢复脱敏策略。
 */
export class ClientLogPrivacy {
  private readonly identifiers: Array<{ kind: LogIdentifierKind; value: string }>;

  constructor(identifiers: LogIdentifiers, _key?: Buffer) {
    this.identifiers = Object.entries(identifiers)
      .filter((entry): entry is [LogIdentifierKind, string] => typeof entry[1] === 'string' && entry[1].length > 0)
      .map(([kind, value]) => ({ kind, value }))
      .sort((left, right) => right.value.length - left.value.length);
  }

  sanitize(value: unknown): { value: unknown; matched_identifiers: MatchedIdentifier[] } {
    const matched = new Set<LogIdentifierKind>();
    const bounded = this.walk(value, matched, 0);
    return {
      value: bounded,
      matched_identifiers: [...matched].sort().map((kind) => ({ kind, matched: true })),
    };
  }

  /** 不脱敏：长文本原样返回。 */
  sanitizeText(text: string): string {
    return text;
  }

  entryId(value: unknown): string {
    const bounded = this.sanitize(value).value;
    return `log-${createHash('sha256').update(JSON.stringify(canonical(bounded))).digest('hex').slice(0, 24)}`;
  }

  /** 不脱敏：流式输出无需暂扣任何后缀。 */
  sensitiveSuffixLength(_text: string): number {
    return 0;
  }

  private walk(value: unknown, matched: Set<LogIdentifierKind>, depth: number): unknown {
    if (depth > 12) return '[truncated-depth]';
    if (typeof value === 'string') {
      for (const identifier of this.identifiers) {
        const pattern = new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(identifier.value)}(?![A-Za-z0-9])`,
        );
        if (pattern.test(value)) matched.add(identifier.kind);
      }
      return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    if (typeof value === 'number') {
      const raw = String(value);
      for (const identifier of this.identifiers) {
        if (identifier.value === raw) matched.add(identifier.kind);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => this.walk(item, matched, depth + 1));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 40)
          .map(([key, item]) => [key, this.walk(item, matched, depth + 1)]),
      );
    }
    return value;
  }
}
