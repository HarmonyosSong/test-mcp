import { createHash } from 'node:crypto';

import {
  DiagnosisReportDraftSchema,
  DiagnosisReportSchema,
  EvidenceSchema,
  type DiagnosisReport,
  type DiagnosisReportDraft,
  type Evidence,
} from '../domain/schemas.js';

export type EvidenceSnapshot = {
  entries: Evidence[];
  texts: Record<string, string>;
  evicted: Record<string, string>;
  max_entries: number;
  max_current_turn: number;
  max_current_turn_bytes: number;
  ledger_version: 2;
};

export class EvidenceLedgerError extends Error {
  constructor(
    readonly code:
      | 'unknown_evidence_id'
      | 'evidence_expired'
      | 'excerpt_mismatch'
      | 'positive_without_observed_source',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'EvidenceLedgerError';
  }
}

const DEFAULTS = {
  maxEntries: 300,
  maxCurrentTurn: 1_000,
  maxCurrentTurnBytes: 4 * 1024 * 1024,
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codepointSlice(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('');
}

// Match Python json.dumps(..., sort_keys=True), whose spaces and Unicode
// escapes are part of the persisted evidence ID contract.
function pythonJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    let escaped = '"';
    for (const char of value) {
      const point = char.codePointAt(0)!;
      if (char === '"') escaped += '\\"';
      else if (char === '\\') escaped += '\\\\';
      else if (char === '\b') escaped += '\\b';
      else if (char === '\f') escaped += '\\f';
      else if (char === '\n') escaped += '\\n';
      else if (char === '\r') escaped += '\\r';
      else if (char === '\t') escaped += '\\t';
      else if (point < 0x20 || point > 0x7e) {
        if (point <= 0xffff) {
          escaped += `\\u${point.toString(16).padStart(4, '0')}`;
        } else {
          const adjusted = point - 0x10000;
          const high = 0xd800 + (adjusted >> 10);
          const low = 0xdc00 + (adjusted & 0x3ff);
          escaped += `\\u${high.toString(16)}\\u${low.toString(16)}`;
        }
      } else escaped += char;
    }
    return `${escaped}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${pythonJson(key)}: ${pythonJson(record[key])}`).join(', ')}}`;
  }
  return 'null';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

export class EvidenceLedger {
  readonly entries = new Map<string, Evidence>();
  readonly texts = new Map<string, string>();
  readonly inputTexts: string[];
  readonly userRefs = new Map<string, string>();
  readonly evicted = new Map<string, string>();
  readonly currentTurnIds = new Set<string>();
  currentTurnBytes = 0;
  restoredCount = 0;
  expiredCount = 0;

  constructor(options: {
    inputTexts?: string[];
    maxEntries?: number;
    maxCurrentTurn?: number;
    maxCurrentTurnBytes?: number;
  } = {}) {
    this.inputTexts = [...(options.inputTexts ?? [])];
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULTS.maxEntries);
    this.maxCurrentTurn = positiveInteger(options.maxCurrentTurn, DEFAULTS.maxCurrentTurn);
    this.maxCurrentTurnBytes = positiveInteger(
      options.maxCurrentTurnBytes,
      DEFAULTS.maxCurrentTurnBytes,
    );
  }

  readonly maxEntries: number;
  readonly maxCurrentTurn: number;
  readonly maxCurrentTurnBytes: number;

  registerUserTexts(): Array<{ id: string; preview: string }> {
    return this.inputTexts.map((text) => {
      const id = `ev-user-${sha256(text).slice(0, 12)}`;
      if (!this.userRefs.has(id)) this.userRefs.set(id, text);
      return { id, preview: codepointSlice(text, 40) };
    });
  }

  add(rawEvidence: Evidence, text?: string): boolean {
    const evidence = EvidenceSchema.parse(rawEvidence);
    const body = text ?? evidence.excerpt;
    const incomingBytes = byteLength(body);
    const isNew = !this.entries.has(evidence.id);
    const isCurrentTurn = this.currentTurnIds.has(evidence.id);
    if (
      !isCurrentTurn &&
      (this.currentTurnIds.size >= this.maxCurrentTurn ||
        this.currentTurnBytes + incomingBytes > this.maxCurrentTurnBytes)
    ) {
      return false;
    }

    this.entries.set(evidence.id, evidence);
    this.texts.set(evidence.id, body);
    if (this.evicted.delete(evidence.id)) this.restoredCount += 1;
    if (!isCurrentTurn) {
      this.currentTurnIds.add(evidence.id);
      this.currentTurnBytes += incomingBytes;
    }

    while (this.entries.size > this.maxEntries) {
      const evictable = [...this.entries.keys()].find((id) => !this.currentTurnIds.has(id));
      if (evictable === undefined) break;
      const removed = this.entries.get(evictable);
      this.evicted.set(evictable, removed?.location ?? 'unknown');
      this.entries.delete(evictable);
      this.texts.delete(evictable);
    }
    while (this.evicted.size > 500) {
      const oldest = this.evicted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.evicted.delete(oldest);
    }
    return true;
  }

  snapshot(): EvidenceSnapshot {
    return {
      entries: [...this.entries.values()],
      texts: Object.fromEntries(this.texts),
      evicted: Object.fromEntries(this.evicted),
      max_entries: this.maxEntries,
      max_current_turn: this.maxCurrentTurn,
      max_current_turn_bytes: this.maxCurrentTurnBytes,
      ledger_version: 2,
    };
  }

  static restore(state: unknown, inputTexts: string[] = []): EvidenceLedger {
    const snapshot = isRecord(state) ? state : {};
    const ledger = new EvidenceLedger({
      inputTexts,
      maxEntries: positiveInteger(snapshot.max_entries, DEFAULTS.maxEntries),
      maxCurrentTurn: positiveInteger(snapshot.max_current_turn, DEFAULTS.maxCurrentTurn),
      maxCurrentTurnBytes: positiveInteger(
        snapshot.max_current_turn_bytes,
        DEFAULTS.maxCurrentTurnBytes,
      ),
    });

    if (Array.isArray(snapshot.entries)) {
      for (const raw of snapshot.entries) {
        const parsed = EvidenceSchema.safeParse(raw);
        if (parsed.success) ledger.entries.set(parsed.data.id, parsed.data);
      }
    }
    if (isRecord(snapshot.texts)) {
      for (const [id, text] of Object.entries(snapshot.texts)) {
        if (ledger.entries.has(id) && typeof text === 'string') ledger.texts.set(id, text);
      }
    }
    for (const [id, evidence] of ledger.entries) {
      if (!ledger.texts.has(id)) ledger.texts.set(id, evidence.excerpt);
    }
    if (isRecord(snapshot.evicted)) {
      for (const [id, location] of Object.entries(snapshot.evicted)) {
        if (!ledger.entries.has(id)) ledger.evicted.set(id, String(location));
      }
    }
    return ledger;
  }

  capture(name: string, arguments_: Record<string, unknown>, result: unknown): unknown {
    const observedTools = new Set(['read_project_file', 'search_project_text', 'parse_hilog']);
    if (!observedTools.has(name)) return result;

    if (
      name === 'parse_hilog' &&
      !(typeof arguments_.log_text === 'string' && arguments_.log_text.length > 0 &&
        this.inputTexts.some((text) => text.includes(arguments_.log_text as string)))
    ) {
      return {
        evidence_refs: [],
        result,
        limitation: '解析输入未对应已提供的日志，不能作为本次故障的观测证据。',
      };
    }

    let rows: unknown[];
    if (name === 'parse_hilog' && isRecord(result) && Array.isArray(result.error_lines)) {
      rows = result.error_lines;
    } else if (
      name === 'search_project_text' && isRecord(result) && Array.isArray(result.matches)
    ) {
      rows = result.matches;
    } else {
      rows = Array.isArray(result) ? result : [result];
    }

    const evidenceRefs: Array<Omit<Evidence, 'excerpt' | 'supports'>> = [];
    let capacityReached = false;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const text = row.content ?? row.excerpt ?? '';
      if (typeof text !== 'string' || !text.trim()) continue;
      const path = row.path ?? 'pasted-hilog';
      const line = row.line ?? row.start_line ?? 1;
      const location = `${String(path)}:${String(line)}`;
      const idPayload = pythonJson([name, arguments_, location, text]);
      const evidence = EvidenceSchema.parse({
        id: `ev-${sha256(idPayload).slice(0, 16)}`,
        kind: name === 'parse_hilog' ? 'log' : 'source',
        source: `mcp:${name}`,
        location,
        excerpt: codepointSlice(text, 2_000),
        supports: '工具实际返回的观测；是否支持因果关系仍需判断',
      });
      if (!this.add(evidence, text)) {
        capacityReached = true;
        break;
      }
      const { excerpt: _excerpt, supports: _supports, ...reference } = evidence;
      evidenceRefs.push(reference);
    }

    if (capacityReached) {
      return {
        evidence_refs: evidenceRefs,
        result,
        observation_capacity_reached: true,
        limitation: '本轮观测容量已达上限;未接纳的行没有可引用 ID。请用已有观测收尾。',
      };
    }
    return { evidence_refs: evidenceRefs, result };
  }

  resolveDraft(rawDraft: DiagnosisReportDraft | unknown): DiagnosisReport {
    const draft = DiagnosisReportDraftSchema.parse(rawDraft);
    const resolved: Evidence[] = [];
    for (const citation of draft.evidence) {
      const userText = this.userRefs.get(citation.id);
      if (userText !== undefined) {
        if (!userText.includes(citation.excerpt.trim())) {
          throw new EvidenceLedgerError(
            'excerpt_mismatch',
            `${citation.id} 是用户输入引用，摘录必须逐字摘自该条用户消息。`,
          );
        }
        resolved.push(EvidenceSchema.parse({
          id: citation.id,
          kind: 'user',
          source: 'user-message',
          location: `${codepointSlice(userText, 30)}${Array.from(userText).length > 30 ? '…' : ''}`,
          excerpt: citation.excerpt,
          supports: citation.supports,
        }));
        continue;
      }

      const observed = this.entries.get(citation.id);
      if (!observed) {
        if (this.evicted.has(citation.id)) {
          this.expiredCount += 1;
          throw new EvidenceLedgerError(
            'evidence_expired',
            `${citation.id} 的观测已被淘汰；原位置 ${this.evicted.get(citation.id)}，重读该位置同内容可恢复同一 ID。`,
          );
        }
        const available = [...this.entries]
          .slice(-20)
          .map(([id, item]) => `${id}(${item.location ?? 'unknown'})`)
          .join(', ');
        throw new EvidenceLedgerError(
          'unknown_evidence_id',
          `${citation.id} 从未被观测。可用 ID(最近 20):${available || '无'}。请照抄清单 ID 或重新观测。`,
        );
      }
      const observedText = this.texts.get(citation.id) ?? observed.excerpt;
      if (!observedText.includes(citation.excerpt.trim())) {
        throw new EvidenceLedgerError(
          'excerpt_mismatch',
          `${citation.id} 的摘录必须是观测原文的逐字子串。`,
        );
      }
      resolved.push(EvidenceSchema.parse({
        id: observed.id,
        kind: observed.kind,
        source: observed.source,
        location: observed.location,
        excerpt: citation.excerpt,
        supports: citation.supports,
      }));
    }

    const report = DiagnosisReportSchema.parse({ ...draft, evidence: resolved });
    const byId = new Map(report.evidence.map((item) => [item.id, item]));
    for (const candidate of report.root_cause_candidates) {
      if (!candidate.evidence_ids.some((id) => {
        const item = byId.get(id);
        return item?.kind === 'source' || item?.kind === 'log';
      })) {
        throw new EvidenceLedgerError(
          'positive_without_observed_source',
          '每个根因候选都必须引用至少一条本次源码或日志观测；用户输入和知识线索不能单独构成根因候选。',
        );
      }
    }
    return report;
  }
}
