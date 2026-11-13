import { createHash } from 'node:crypto';

import {
  DiagnosisReportDraftSchema,
  DiagnosisReportSchema,
  EvidenceSchema,
  type DiagnosisReport,
  type DiagnosisReportDraft,
  type Evidence,
  type SourceRepositoryBinding,
  type SourceSnapshotIdentity,
} from '../domain/schemas.js';
import type { ClientLogPrivacy } from '../security/log-privacy.js';

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
      | 'positive_without_observed_source'
      | 'log_evidence_unrelated'
      | 'source_snapshot_mismatch',
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

type EvidenceReference = Omit<Evidence, 'excerpt' | 'supports'> & Partial<Pick<Evidence, 'excerpt' | 'supports'>>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codepointSlice(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('');
}

/** 摘录匹配的展示层归一：连续空白折叠为单个空格。反伪造强度不变——非空白内容仍须逐字一致。 */
function normalizeForExcerptMatch(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** 模型引用片段时习惯在首尾自加省略号；匹配前剥掉，避免展示习惯被误判为伪造。 */
function normalizeExcerpt(raw: string): string {
  return raw.trim().replace(/^(?:…|\.\.\.)+/, '').replace(/(?:…|\.\.\.)+$/, '').trim();
}

/** 日志正文通常是 JSON.stringify 后的字符串；模型引用嵌套 JSON 时会省略转义反斜杠。 */
function normalizeJsonEscapes(text: string): string {
  return text.replace(/\\(["'])/g, '$1');
}

/** 空白归一后的连续片段匹配；摘录被剥到为空时没有证明力，视为不匹配。 */
function excerptMatches(observedText: string, excerpt: string): boolean {
  const needle = normalizeExcerpt(excerpt);
  if (!needle) return false;
  const observedVariants = [observedText, normalizeJsonEscapes(observedText)];
  const needleVariants = [needle, normalizeJsonEscapes(needle)];
  return observedVariants.some((observedVariant) =>
    needleVariants.some((needleVariant) =>
      normalizeForExcerptMatch(observedVariant).includes(normalizeForExcerptMatch(needleVariant)),
    ),
  );
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

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !normalized.split('/').some((part) => part === '.' || part === '..' || part === '');
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

export class EvidenceLedger {
  readonly entries = new Map<string, Evidence>();
  readonly texts = new Map<string, string>();
  readonly inputTexts: string[];
  readonly userRefs = new Map<string, string>();
  /** Remote log entry IDs are presentation IDs; resolve them only when observed in this ledger. */
  readonly evidenceAliases = new Map<string, string>();
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
    privacy?: ClientLogPrivacy;
    sourceContext?: SourceSnapshotIdentity;
    sourceContexts?: readonly SourceRepositoryBinding[];
  } = {}) {
    this.inputTexts = [...(options.inputTexts ?? [])];
    this.privacy = options.privacy;
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULTS.maxEntries);
    this.maxCurrentTurn = positiveInteger(options.maxCurrentTurn, DEFAULTS.maxCurrentTurn);
    this.maxCurrentTurnBytes = positiveInteger(
      options.maxCurrentTurnBytes,
      DEFAULTS.maxCurrentTurnBytes,
    );
    this.sourceContext = options.sourceContext;
    this.sourceContexts = [...(options.sourceContexts ?? [])];
  }

  readonly maxEntries: number;
  readonly maxCurrentTurn: number;
  readonly maxCurrentTurnBytes: number;
  private readonly privacy?: ClientLogPrivacy;
  private readonly sourceContext?: SourceSnapshotIdentity;
  private readonly sourceContexts: readonly SourceRepositoryBinding[];

  registerUserTexts(): Array<{ id: string; preview: string }> {
    return this.inputTexts.map((text) => {
      const id = `ev-user-${sha256(text).slice(0, 12)}`;
      if (!this.userRefs.has(id)) this.userRefs.set(id, text);
      return { id, preview: codepointSlice(text, 40) };
    });
  }

  add(rawEvidence: Evidence, text?: string): boolean {
    const evidence = EvidenceSchema.parse(rawEvidence);
    this.assertSourceSnapshot(evidence);
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
    this.registerEvidenceAliases(evidence);
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

  static restore(
    state: unknown,
    inputTexts: string[] = [],
    privacy?: ClientLogPrivacy,
    sourceContext?: SourceSnapshotIdentity,
    sourceContexts: readonly SourceRepositoryBinding[] = [],
  ): EvidenceLedger {
    const snapshot = isRecord(state) ? state : {};
    const ledger = new EvidenceLedger({
      inputTexts,
      privacy,
      maxEntries: positiveInteger(snapshot.max_entries, DEFAULTS.maxEntries),
      maxCurrentTurn: positiveInteger(snapshot.max_current_turn, DEFAULTS.maxCurrentTurn),
      maxCurrentTurnBytes: positiveInteger(
        snapshot.max_current_turn_bytes,
        DEFAULTS.maxCurrentTurnBytes,
      ),
      sourceContext,
      sourceContexts,
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
      ledger.registerEvidenceAliases(evidence);
    }
    if (isRecord(snapshot.evicted)) {
      for (const [id, location] of Object.entries(snapshot.evicted)) {
        if (!ledger.entries.has(id)) ledger.evicted.set(id, String(location));
      }
    }
    return ledger;
  }

  capture(name: string, arguments_: Record<string, unknown>, result: unknown): unknown {
    if (name === 'search_cloud_logs' || name === 'query_logs' || name === 'discover_client_sessions') {
      return this.captureRemoteLogs(name, result);
    }
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

    const evidenceRefs: EvidenceReference[] = [];
    let capacityReached = false;
    let sourcePathsRejected = 0;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const rawText = row.content ?? row.excerpt ?? '';
      if (typeof rawText !== 'string' || !rawText.trim()) continue;
      const text = name === 'parse_hilog' && this.privacy
        ? String(this.privacy.sanitize(rawText).value)
        : rawText;
      const path = String(row.path ?? 'pasted-hilog').trim() || 'pasted-hilog';
      const line = row.line ?? row.start_line ?? 1;
      const location = `${String(path)}:${String(line)}`;
      const sourceContext = name === 'parse_hilog' ? undefined : this.sourceContextForPath(path);
      if (name !== 'parse_hilog' && this.sourceContexts.length > 0 && !sourceContext) {
        sourcePathsRejected += 1;
        continue;
      }
      const idPayload = pythonJson([name, arguments_, location, text, sourceContext]);
      const evidence = EvidenceSchema.parse({
        id: `ev-${sha256(idPayload).slice(0, 16)}`,
        kind: name === 'parse_hilog' ? 'log' : 'source',
        source: `mcp:${name}`,
        location,
        excerpt: codepointSlice(text, 2_000),
        supports: '工具实际返回的观测；是否支持因果关系仍需判断',
        ...(sourceContext ? { source_context: sourceContext } : {}),
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
    return {
      evidence_refs: evidenceRefs,
      result,
      ...(sourcePathsRejected > 0 ? { source_paths_rejected: sourcePathsRejected } : {}),
      ...(evidenceRefs.length === 0 && rows.length > 0 && this.sourceContexts.length > 0
        ? { limitation: '源码路径无法归属当前会话绑定的仓库挂载点，未进入证据账本。' }
        : {}),
    };
  }

  private sourceContextForPath(rawPath: string): SourceSnapshotIdentity & { path: string } | undefined {
    const path = rawPath.replaceAll('\\', '/').trim();
    if (!isSafeRelativePath(path)) return undefined;
    if (this.sourceContexts.length > 0) {
      const binding = [...this.sourceContexts]
        .sort((left, right) => right.mount_path.length - left.mount_path.length)
        .find((item) => item.mount_path === '' || path === item.mount_path || path.startsWith(`${item.mount_path}/`));
      if (!binding) return undefined;
      const relativePath = binding.mount_path === '' ? path : path.slice(binding.mount_path.length + 1);
      if (!relativePath) return undefined;
      return {
        repository_id: binding.repository_id,
        resolved_commit: binding.resolved_commit,
        path: relativePath,
      };
    }
    return this.sourceContext ? { ...this.sourceContext, path } : undefined;
  }

  private captureRemoteLogs(name: string, result: unknown): unknown {
    if (!isRecord(result)) return { evidence_refs: [], result };
    const rows = name === 'search_cloud_logs' || name === 'query_logs'
      ? result.entries
      : Array.isArray(result.candidates)
        ? result.candidates.flatMap((candidate) => isRecord(candidate) && Array.isArray(candidate.entries)
          ? candidate.entries
          : [])
        : [];
    if (!Array.isArray(rows)) return { evidence_refs: [], result };

    const evidenceRefs: EvidenceReference[] = [];
    let rejected = 0;
    let capacityReached = false;
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.observation_context)) {
        rejected += 1;
        continue;
      }
      const context = row.observation_context;
      const correlated = context.service_binding !== undefined
        && isRecord(context.service_binding)
        && context.service_binding.status === 'confirmed'
        && Array.isArray(context.matched_identifiers)
        && context.matched_identifiers.length > 0;
      const text = row.excerpt;
      if (!correlated || typeof text !== 'string' || !text.trim()) {
        rejected += 1;
        continue;
      }
      const location = typeof row.location === 'string' ? row.location : null;
      // 不用模型工具参数生成 ID，避免原始学员标识进入证据快照。
      const idPayload = pythonJson([
        name,
        {
          entry_id: context.entry_id,
          store_id: context.store_id,
          appid: context.appid,
          start: context.start,
          end: context.end,
          page: context.page,
        },
        location,
        text,
      ]);
      try {
        const evidence = EvidenceSchema.parse({
          id: `ev-${sha256(idPayload).slice(0, 16)}`,
          kind: 'log',
          source: `logcenter:${name}`,
          location,
          excerpt: codepointSlice(text, 2_000),
          supports: '已绑定目标并匹配当前用户标识的远程日志（内网明文，不脱敏）；因果关系仍需判断',
          observation_context: context,
        });
        if (!this.add(evidence, text)) {
          capacityReached = true;
          break;
        }
        // Keep the exact serialized observation beside the ID. This avoids making
        // the model reconstruct nested JSON from the surrounding result payload.
        const reference = { ...evidence };
        evidenceRefs.push(reference);
      } catch {
        rejected += 1;
      }
    }
    return {
      evidence_refs: evidenceRefs,
      result,
      ...(rejected > 0 ? { uncorrelated_entries_rejected: rejected } : {}),
      ...(capacityReached ? {
        observation_capacity_reached: true,
        limitation: '本轮观测容量已达上限；未接纳的日志没有可引用 ID。请用已有观测收尾。',
      } : evidenceRefs.length === 0 && rows.length > 0 ? {
        limitation: '日志未完成当前学员身份匹配或目标绑定，未进入证据账本；不能据此确认平台或根因。',
      } : {}),
    };
  }

  private assertSourceSnapshot(evidence: Evidence): void {
    if (evidence.kind !== 'source' || (!this.sourceContext && this.sourceContexts.length === 0)) return;
    const boundSourceContext = this.sourceContext;
    const context = evidence.source_context;
    if (!context) {
      throw new EvidenceLedgerError(
        'source_snapshot_mismatch',
        '当前会话绑定了源码快照，但该源码观测没有 Runtime 注入的仓库和 commit 身份。请重新读取当前快照。',
      );
    }
    if (!isSafeRelativePath(context.path)) {
      throw new EvidenceLedgerError('source_snapshot_mismatch', '源码观测路径必须是当前快照内的安全相对路径。');
    }
    if (this.sourceContexts.length > 0) {
      const matchingBinding = this.sourceContexts.some((binding) => (
        context.repository_id === binding.repository_id &&
        context.resolved_commit === binding.resolved_commit &&
        context.path.length > 0
      ));
      if (matchingBinding) return;
      throw new EvidenceLedgerError(
        'source_snapshot_mismatch',
        `源码观测属于 ${context.repository_id}@${context.resolved_commit}，不在当前会话绑定的多仓快照中。`,
      );
    }
    if (
      context.repository_id !== boundSourceContext?.repository_id ||
      context.resolved_commit !== boundSourceContext?.resolved_commit
    ) {
      throw new EvidenceLedgerError(
        'source_snapshot_mismatch',
        `源码观测属于 ${context.repository_id}@${context.resolved_commit}，与当前会话绑定的 ${boundSourceContext?.repository_id}@${boundSourceContext?.resolved_commit} 不一致。`,
      );
    }
  }

  private registerEvidenceAliases(evidence: Evidence): void {
    if (evidence.kind !== 'log' || !evidence.observation_context) return;
    const entryId = evidence.observation_context.entry_id;
    const aliases = [
      entryId,
      `ev-${entryId.slice('log-'.length)}`,
      evidence.location?.split('#').at(-1) ?? '',
    ];
    for (const alias of aliases) {
      if (alias && alias !== evidence.id && !this.evidenceAliases.has(alias)) {
        this.evidenceAliases.set(alias, evidence.id);
      }
    }
  }

  private validateVerifiedClaims(report: DiagnosisReport): void {
    report.joint_assessment?.verified_claims.forEach((claim, claimIndex) => {
      for (const id of claim.evidence_ids) {
        if (this.entries.has(id) || this.userRefs.has(id)) continue;
        if (this.evicted.has(id)) {
          this.expiredCount += 1;
          throw new EvidenceLedgerError(
            'evidence_expired',
            `joint_assessment.verified_claims[${claimIndex}] 引用的 ${id} 已被淘汰；请重新观测后再提交。`,
          );
        }
        throw new EvidenceLedgerError(
          'unknown_evidence_id',
          `joint_assessment.verified_claims[${claimIndex}] 引用的 ${id} 不在本地证据账本中；consultation、task 和其他外部 ID 不能作为已验证主张的证据。禁止自创可读 ID，只能照抄账本已有 ID。`,
        );
      }
    });
  }

  resolveDraft(rawDraft: DiagnosisReportDraft | unknown): DiagnosisReport {
    const canonicalId = (id: string): string => this.evidenceAliases.get(id) ?? id;
    const aliasesResolved = isRecord(rawDraft) ? {
      ...rawDraft,
      evidence: Array.isArray(rawDraft.evidence)
        ? rawDraft.evidence.map((item) => isRecord(item) && typeof item.id === 'string'
          ? { ...item, id: canonicalId(item.id) }
          : item)
        : rawDraft.evidence,
      root_cause_candidates: Array.isArray(rawDraft.root_cause_candidates)
        ? rawDraft.root_cause_candidates.map((item) => isRecord(item) && Array.isArray(item.evidence_ids)
          ? { ...item, evidence_ids: item.evidence_ids.map((id) => typeof id === 'string' ? canonicalId(id) : id) }
          : item)
        : rawDraft.root_cause_candidates,
      joint_assessment: isRecord(rawDraft.joint_assessment) && Array.isArray(rawDraft.joint_assessment.verified_claims)
        ? {
            ...rawDraft.joint_assessment,
            verified_claims: rawDraft.joint_assessment.verified_claims.map((item) => isRecord(item) && Array.isArray(item.evidence_ids)
              ? { ...item, evidence_ids: item.evidence_ids.map((id) => typeof id === 'string' ? canonicalId(id) : id) }
              : item),
          }
        : rawDraft.joint_assessment,
    } : rawDraft;
    const canonicalDraft = DiagnosisReportDraftSchema.parse(aliasesResolved);
    const resolved: Evidence[] = [];
    for (const citation of canonicalDraft.evidence) {
      const userText = this.userRefs.get(citation.id);
      if (userText !== undefined) {
        if (!excerptMatches(userText, citation.excerpt)) {
          throw new EvidenceLedgerError(
            'excerpt_mismatch',
            `${citation.id} 是用户输入引用，摘录必须逐字摘自该条用户消息（允许跨行，首尾不要自加省略号）。`,
          );
        }
        resolved.push(EvidenceSchema.parse({
          id: citation.id,
          kind: 'user',
          source: 'user-message',
          location: `${codepointSlice(this.privacy ? String(this.privacy.sanitize(userText).value) : userText, 30)}${Array.from(userText).length > 30 ? '…' : ''}`,
          excerpt: this.privacy ? String(this.privacy.sanitize(citation.excerpt).value) : citation.excerpt,
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
          `${citation.id} 从未被观测。可用 ID(最近 20):${available || '无'}。请照抄清单 ID 或重新观测；禁止自创可读 ID（如 ev-user-语义命名）。`,
        );
      }
      const observedText = this.texts.get(citation.id) ?? observed.excerpt;
      this.assertSourceSnapshot(observed);
      if (!excerptMatches(observedText, citation.excerpt)) {
        throw new EvidenceLedgerError(
          'excerpt_mismatch',
          `${citation.id} 的摘录不是该观测原文的连续片段。请从对应工具返回的原文中逐字复制一段（允许跨行，空白差异会被归一，首尾不要自加省略号）；找不到就重新观测。`,
        );
      }
      resolved.push(EvidenceSchema.parse({
        id: observed.id,
        kind: observed.kind,
        source: observed.source,
        location: observed.location,
        excerpt: citation.excerpt,
        supports: citation.supports,
        observation_context: observed.observation_context,
        source_context: observed.source_context,
      }));
    }

    const report = DiagnosisReportSchema.parse({ ...canonicalDraft, evidence: resolved });
    const byId = new Map(report.evidence.map((item) => [item.id, item]));
    for (const candidate of report.root_cause_candidates) {
      for (const id of candidate.evidence_ids) {
        const item = byId.get(id);
        const context = item?.observation_context;
        if (item?.kind === 'log' && context && !(
          context.service_binding.status === 'confirmed'
          && context.matched_identifiers.length > 0
        )) {
          throw new EvidenceLedgerError(
            'log_evidence_unrelated',
            '远程日志未完成目标绑定和当前学员身份匹配，不能支持根因候选；请补充关联日志或移除该候选。',
          );
        }
      }
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
    this.validateVerifiedClaims(report);
    return report;
  }
}
