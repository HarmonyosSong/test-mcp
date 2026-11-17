import { createHash } from 'node:crypto';

import type {
  SourceRepositoryBinding,
  SourceSnapshotIdentity,
} from '../domain/schemas.js';
import type { ClientLogPrivacy } from '../security/log-privacy.js';

/**
 * 瘦观测注册表：去编排化后的证据机制（替代 EvidenceLedger）。
 *
 * 职责收窄为三件事：
 * 1. 给真实观测发放稳定 ev-ID（内容哈希，跨进程/跨轮同内容同 ID）；
 * 2. 保留观测元数据（kind/source/location/observation_context/source_context），
 *    供平台版本提取（prompt-version-context）与防伪存在性校验使用；
 * 3. 跨轮恢复：append-only、无淘汰、无墓碑——观测一经登记永不"过期"。
 *
 * 不再承担：excerpt 逐字校验、报告 draft 解析、容量淘汰。最终答案的证据引用
 * 由 final-answer-validator 做存在性校验，摘录真实性交给模型自律与评测。
 */

export type ObservationEntry = {
  id: string;
  kind: string;
  source: string;
  location: string | null;
  observation_context?: Record<string, unknown>;
  source_context?: SourceSnapshotIdentity & { path: string };
};

/** 快照形状保持 {entries:[{observation_context,...}]} 兼容：observedLogContext 零改动读取。 */
export type ObservationSnapshot = {
  entries: ObservationEntry[];
  registry_version: 1;
};

const SOFT_ENTRY_LIMIT = 500;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codepointSlice(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('');
}

// Match Python json.dumps(..., sort_keys=True): spaces and Unicode escapes are
// part of the persisted evidence ID contract (kept identical to EvidenceLedger).
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !normalized.split('/').some((part) => part === '.' || part === '..' || part === '');
}

export class ObservationRegistry {
  readonly entries = new Map<string, ObservationEntry>();
  readonly userRefs = new Map<string, string>();
  /** Remote log entry IDs are presentation IDs; resolve them only when observed here. */
  readonly evidenceAliases = new Map<string, string>();
  readonly inputTexts: string[];

  constructor(options: {
    inputTexts?: string[];
    privacy?: ClientLogPrivacy;
    sourceContext?: SourceSnapshotIdentity;
    sourceContexts?: readonly SourceRepositoryBinding[];
    /** 对照端绑定在轮内由 prepare_source 晚于注册表构造发生，故用 thunk 延迟读取。 */
    compareSourceContexts?: () => readonly SourceRepositoryBinding[];
  } = {}) {
    this.inputTexts = [...(options.inputTexts ?? [])];
    this.privacy = options.privacy;
    this.sourceContext = options.sourceContext;
    this.sourceContexts = [...(options.sourceContexts ?? [])];
    this.compareSourceContexts = options.compareSourceContexts;
  }

  private readonly privacy?: ClientLogPrivacy;
  private readonly sourceContext?: SourceSnapshotIdentity;
  private readonly sourceContexts: readonly SourceRepositoryBinding[];
  private readonly compareSourceContexts?: () => readonly SourceRepositoryBinding[];

  registerUserTexts(): Array<{ id: string; preview: string }> {
    return this.inputTexts.map((text) => {
      const id = `ev-user-${sha256(text).slice(0, 12)}`;
      if (!this.userRefs.has(id)) this.userRefs.set(id, text);
      return { id, preview: codepointSlice(text, 40) };
    });
  }

  /** 最终答案校验器的存在性查询：注册表条目、用户引用与日志别名均可引用。 */
  has(id: string): boolean {
    return this.entries.has(id) || this.userRefs.has(id) || this.evidenceAliases.has(id);
  }

  /** 元数据查询（如按 id 取 location），供校验器生成纠错反馈。 */
  get(id: string): ObservationEntry | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }

  private add(entry: ObservationEntry): void {
    this.entries.set(entry.id, entry);
    if (entry.kind === 'log' && isRecord(entry.observation_context)) {
      const entryId = entry.observation_context.entry_id;
      if (typeof entryId === 'string') {
        const aliases = [
          entryId,
          entryId.startsWith('log-') ? `ev-${entryId.slice('log-'.length)}` : '',
          typeof entry.location === 'string' ? entry.location.split('#').at(-1) ?? '' : '',
        ];
        for (const alias of aliases) {
          if (alias && alias !== entry.id && !this.evidenceAliases.has(alias)) {
            this.evidenceAliases.set(alias, entry.id);
          }
        }
      }
    }
  }

  snapshot(): ObservationSnapshot {
    return {
      entries: [...this.entries.values()],
      registry_version: 1,
    };
  }

  /**
   * 兼容读取：新快照（registry_version=1）直接恢复；旧 EvidenceLedger 快照
   * （ledger_version=2）只取 entries 的元数据字段，忽略 texts/evicted/容量配置。
   * 用户引用不持久化——ID 由用户文本内容哈希决定，每轮用 inputTexts 重新注册。
   * options 与构造器一致；compareSourceContexts 为轮内晚绑定 thunk。
   */
  static restore(
    state: unknown,
    options: {
      inputTexts?: string[];
      privacy?: ClientLogPrivacy;
      sourceContext?: SourceSnapshotIdentity;
      sourceContexts?: readonly SourceRepositoryBinding[];
      compareSourceContexts?: () => readonly SourceRepositoryBinding[];
    } = {},
  ): ObservationRegistry {
    const registry = new ObservationRegistry(options);
    const snapshot = isRecord(state) ? state : {};
    if (!Array.isArray(snapshot.entries)) return registry;
    for (const raw of snapshot.entries) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) continue;
      if (registry.entries.has(raw.id)) continue;
      registry.add({
        id: raw.id,
        kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
        source: typeof raw.source === 'string' ? raw.source : 'unknown',
        location: typeof raw.location === 'string' ? raw.location : null,
        ...(isRecord(raw.observation_context) ? { observation_context: raw.observation_context } : {}),
        ...(isRecord(raw.source_context)
          ? { source_context: raw.source_context as ObservationEntry['source_context'] }
          : {}),
      });
    }
    return registry;
  }

  /**
   * 工具结果观测登记：为每个真实返回的观测行发放 ev-ID 并登记元数据。
   * 与 EvidenceLedger.capture 的 ID 生成逻辑逐字节一致（内容哈希契约）。
   */
  capture(name: string, arguments_: Record<string, unknown>, result: unknown): unknown {
    if (name === 'search_cloud_logs' || name === 'query_logs' || name === 'discover_client_sessions') {
      return this.captureRemoteLogs(name, result);
    }
    if (name === 'consult_compass') {
      return this.captureConsult(result);
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

    // target 是懒代理的路由参数（对照端对比）：不进入 ev-ID 内容哈希——事故端"省略 target"
    // 与"显式 target=incident"必须同 ID；它只决定 source_context 归属哪一侧绑定。
    const compareSlot = arguments_.target === 'compare';
    const { target: _routeOnly, ...idArguments } = arguments_;
    const slotContexts = compareSlot
      ? (this.compareSourceContexts?.() ?? [])
      : this.sourceContexts;

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

    const evidenceRefs: ObservationEntry[] = [];
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
      const sourceContext = name === 'parse_hilog' ? undefined : this.sourceContextForPath(path, compareSlot ? slotContexts : undefined);
      // 对照端调用要求对照绑定存在且路径可归属；事故端维持原"已绑定则可归属"规则。
      const bindingsActive = compareSlot || this.sourceContexts.length > 0;
      if (name !== 'parse_hilog' && bindingsActive && !sourceContext) {
        sourcePathsRejected += 1;
        continue;
      }
      const idPayload = pythonJson([name, idArguments, location, text, sourceContext]);
      const entry: ObservationEntry = {
        id: `ev-${sha256(idPayload).slice(0, 16)}`,
        kind: name === 'parse_hilog' ? 'log' : 'source',
        source: `mcp:${name}`,
        location,
        ...(sourceContext ? { source_context: sourceContext } : {}),
      };
      this.add(entry);
      evidenceRefs.push(entry);
    }

    const softLimitReached = this.entries.size > SOFT_ENTRY_LIMIT;
    return {
      evidence_refs: evidenceRefs,
      result,
      ...(sourcePathsRejected > 0 ? { source_paths_rejected: sourcePathsRejected } : {}),
      ...(evidenceRefs.length === 0 && rows.length > 0 && (compareSlot || this.sourceContexts.length > 0)
        ? {
          limitation: compareSlot
            ? '对照端路径无法归属对照快照的仓库挂载点（或对照端未绑定），未登记为观测。'
            : '源码路径无法归属当前会话绑定的仓库挂载点，未登记为观测。',
        }
        : {}),
      ...(softLimitReached
        ? { observation_soft_limit: true, limitation: '观测条目已超过 500 条软上限，请停止泛化取证、用已有观测收尾。' }
        : {}),
    };
  }

  private sourceContextForPath(
    rawPath: string,
    contexts?: readonly SourceRepositoryBinding[],
  ): (SourceSnapshotIdentity & { path: string }) | undefined {
    const path = rawPath.replaceAll('\\', '/').trim();
    if (!isSafeRelativePath(path)) return undefined;
    const list = contexts ?? this.sourceContexts;
    if (list.length > 0) {
      const binding = [...list]
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
    // 显式传入空列表（对照端未绑定）时不回落事故端身份，防止跨端误归因。
    if (contexts) return undefined;
    return this.sourceContext ? { ...this.sourceContext, path } : undefined;
  }

  /**
   * Compass 协查完成态结论登记为正式观测（kind=external）：与本地观测同表、同存在性校验、
   * 同 ev-ID 引用纪律——协查结论与本地证据同级参与诊断，不做"未验证"降级标注。
   * 失败/超时/预算耗尽可能携带部分文本，不是完成态结论，不登记。
   */
  private captureConsult(result: unknown): unknown {
    if (!isRecord(result)) return result;
    if (result.status !== 'completed') return result;
    const text = result.conclusion;
    if (typeof text !== 'string' || !text.trim()) return result;
    const consultationId = typeof result.consultation_id === 'string' ? result.consultation_id : null;
    const idPayload = pythonJson(['consult_compass', { consultation_id: consultationId }, null, text]);
    const entry: ObservationEntry = {
      id: `ev-${sha256(idPayload).slice(0, 16)}`,
      kind: 'external',
      source: 'compass:consult_compass',
      location: null,
      ...(consultationId
        ? { observation_context: { consultation_id: consultationId, truncated: result.truncated === true } }
        : {}),
    };
    this.add(entry);
    const softLimitReached = this.entries.size > SOFT_ENTRY_LIMIT;
    return {
      evidence_refs: [entry],
      result,
      ...(softLimitReached
        ? { observation_soft_limit: true, limitation: '观测条目已超过 500 条软上限，请停止泛化取证、用已有观测收尾。' }
        : {}),
    };
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

    const evidenceRefs: ObservationEntry[] = [];
    let rejected = 0;
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
      // 不用模型工具参数生成 ID，避免原始学员标识进入观测快照。
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
      const entry: ObservationEntry = {
        id: `ev-${sha256(idPayload).slice(0, 16)}`,
        kind: 'log',
        source: `logcenter:${name}`,
        location,
        observation_context: context,
      };
      this.add(entry);
      evidenceRefs.push(entry);
    }
    const softLimitReached = this.entries.size > SOFT_ENTRY_LIMIT;
    return {
      evidence_refs: evidenceRefs,
      result,
      ...(rejected > 0 ? { uncorrelated_entries_rejected: rejected } : {}),
      ...(softLimitReached
        ? { observation_soft_limit: true, limitation: '观测条目已超过 500 条软上限，请停止泛化取证、用已有观测收尾。' }
        : evidenceRefs.length === 0 && rows.length > 0
          ? { limitation: '日志未完成当前学员身份匹配或目标绑定，未登记为观测；不能据此确认平台或根因。' }
          : {}),
    };
  }
}
