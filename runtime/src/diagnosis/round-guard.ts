import { CODE_INDEX_MCP_TOOL_NAMES } from '../model/metadata.js';
import { CodeLocatorRegistry } from './locator-guidance.js';
import type { ObservationRegistry } from './observations.js';

/**
 * RoundGuard：去编排化后的工具护栏（替代 withToolBudget 的 ToolBudget 编排）。
 *
 * 保留的护栏（资源与防呆，不指挥流程）：
 * - 串行 dispatch（工具调用串行执行，避免并发写竞争）；
 * - 调用/失败硬上限（防烧钱兜底）；
 * - 同签名失败禁原样重试（transient 允许一次）；
 * - 可复用结果缓存（签名 + 注册表存在性校验）。
 *
 * 从编排改为软提醒的：
 * - 连续无进展不再硬阻断进 finalize 阶段；达到阈值时在工具结果里附提醒文本，
 *   由模型自主决定调整方向、追问用户或收尾。
 *
 * 新增：
 * - 软时限：到期后所有工具调用被拒绝并提示收尾（compass ExecutionBudget 思想），
 *   由调用方在收尾窗后硬 abort 兜底。
 *
 * 删除的编排：finalize 阶段切换、submit 专属豁免与报告尝试计数。
 */

const SEARCH_TOOLS = new Set(['search_project_text', 'search_code_symbols', 'search_code_index', 'search_knowledge']);
const CODE_NAVIGATION_TOOLS = new Set<string>(CODE_INDEX_MCP_TOOL_NAMES);
const DEFAULT_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  search_project_text: { file_glob: '**/*', limit: 10, cursor: null, target: 'incident' },
  search_code_symbols: { file_pattern: '**/*', limit: 20, target: 'incident' },
  search_code_index: { limit: 10 },
  get_code_outline: { limit: 100, target: 'incident' },
  trace_code_path: { direction: 'inbound', depth: 1, limit: 20, target: 'incident' },
  read_project_file: { start_line: 1, end_line: 200, max_chars: 6000, target: 'incident' },
  list_project_files: { pattern: '**/*', limit: 100, target: 'incident' },
  load_business_context: { target: 'incident' },
  search_knowledge: { scope: 'symptom', limit: 3 },
  get_knowledge_entry: { offset: 0, limit: 2000 },
};
const REUSABLE_TOOLS = new Set([
  'load_skill',
  'lookup_issue',
  'search_knowledge',
  'get_knowledge_entry',
  'list_knowledge_domains',
  'list_symptoms',
  'read_project_file',
  'search_project_text',
  'search_code_symbols',
  'search_code_index',
  'get_code_outline',
  'trace_code_path',
  'list_project_files',
  'load_business_context',
  'parse_hilog',
  'resolve_log_target',
  'count_cloud_logs',
  'search_cloud_logs',
  'count_logs',
  'query_logs',
]);

const NO_PROGRESS_REMINDER =
  '近期多次调用未取得新的有效信息。请检查已有结果：调整有证据支持的排查方向、改用不同来源、' +
  '向用户追问关键缺失信息，或用已有证据收尾；不要原样重复同一查询。';

const SOFT_DEADLINE_MESSAGE =
  '本轮已到收尾时间，工具已关闭。请立即用已有证据给出当前结论，明确证据缺口和未完成事项；不得承诺稍后执行。';

function stableValue(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', ...value.map(stableValue)];
  if (typeof value === 'object')
    return [
      'object',
      ...Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    ];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
  return [typeof value, value];
}

function stableSignature(server: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify([server, name, stableValue({ ...(DEFAULT_TOOL_ARGS[name] ?? {}), ...args })]);
}

function transientFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'transient' in error && error.transient === true) return true;
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const nested = (error as { error: unknown }).error;
    if (
      typeof nested === 'object' && nested !== null && 'data' in nested &&
      typeof (nested as { data: unknown }).data === 'object' && (nested as { data: unknown }).data !== null &&
      'transient' in ((nested as { data: object }).data as object) &&
      ((nested as { data: { transient?: unknown } }).data).transient === true
    ) return true;
  }
  try {
    const parsed = JSON.parse(String(error));
    return typeof parsed === 'object' && parsed !== null && parsed.transient === true;
  } catch {
    return false;
  }
}

function resultFingerprint(name: string, result: unknown): string {
  return `${name}:${JSON.stringify(stableValue(result))}`;
}

function isToolResultError(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null &&
    (('error' in result && (result as { error: unknown }).error === true) ||
      ('isError' in result && (result as { isError: unknown }).isError === true))
  );
}

function navigationResultKeys(value: unknown, prefix = ''): Set<string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const location = `${prefix}:${record.file ?? ''}:${record.qn_prefix ?? ''}`;
  const keys = new Set<string>();
  let recognized = false;
  if (Array.isArray(record.rows)) {
    recognized = true;
    const columns = Array.isArray(record.cols) ? record.cols : [];
    const identityColumns = columns.flatMap((column, index) =>
      ['qn', 'name', 'file', 'lines'].includes(String(column)) ? [index] : []);
    for (const row of record.rows) {
      const identity = Array.isArray(row) && identityColumns.length
        ? identityColumns.map((index) => row[index])
        : row;
      keys.add(`${location}:${JSON.stringify(stableValue(identity))}`);
    }
  }
  for (const field of ['navigation', 'groups', 'callers', 'callees', 'semantic']) {
    if (!(field in record)) continue;
    const children = Array.isArray(record[field]) ? record[field] : [record[field]];
    if (Array.isArray(record[field])) recognized = true;
    for (const child of children) {
      const childKeys = navigationResultKeys(child, `${location}:${field}`);
      if (childKeys === null) continue;
      recognized = true;
      for (const key of childKeys) keys.add(key);
    }
  }
  return recognized ? keys : null;
}

function searchResultKeys(result: unknown): Set<string> {
  const outer = typeof result === 'object' && result !== null && 'result' in result
    ? (result as { result: unknown }).result
    : result;
  const payload = typeof outer === 'object' && outer !== null && 'matches' in outer
    ? (outer as { matches: unknown }).matches
    : outer;
  if (!Array.isArray(payload)) return new Set();
  return new Set(
    payload.map((item) => {
      if (typeof item !== 'object' || item === null) return String(item);
      if ('path' in item)
        return `${String((item as { path: unknown }).path)}:${'line' in item ? String((item as { line: unknown }).line) : ''}`;
      if ('name' in item) return String((item as { name: unknown }).name);
      return JSON.stringify(item);
    }),
  );
}

function truncate(value: unknown, limit = 800): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export type RoundGuardStats = {
  attempts: number;
  failures: number;
  blocked: number;
  cacheHits: number;
  nudges: number;
  softClosed: boolean;
};

export class RoundGuard {
  readonly stats: RoundGuardStats = {
    attempts: 0,
    failures: 0,
    blocked: 0,
    cacheHits: 0,
    nudges: 0,
    softClosed: false,
  };

  private dispatch: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, unknown>();
  private readonly failedSignatures = new Map<string, boolean>();
  private readonly resultSignatures = new Set<string>();
  private readonly searchSeen = new Map<string, Set<string>>();
  private consecutiveNoProgress = 0;
  private readonly locators = new CodeLocatorRegistry();

  constructor(
    private readonly options: {
      observations: ObservationRegistry;
      softDeadlineAt?: number | null;
      callLimit?: number;
      failureLimit?: number;
      noProgressNudgeAt?: number;
    },
  ) {}

  private get softDeadlineAt(): number | null {
    return this.options.softDeadlineAt ?? null;
  }

  private get callLimit(): number {
    return this.options.callLimit ?? 120;
  }

  private get failureLimit(): number {
    return this.options.failureLimit ?? 40;
  }

  private get noProgressNudgeAt(): number {
    return this.options.noProgressNudgeAt ?? 4;
  }

  /** 软时限到期：调用方据此切换系统提示，要求模型直接收尾。 */
  get pastSoftDeadline(): boolean {
    return this.softDeadlineAt !== null && Date.now() >= this.softDeadlineAt;
  }

  wrap<T extends { execute?: (...args: any[]) => any }>(tool: T, server: string, name: string): T {
    if (!tool.execute) return tool;
    const execute = tool.execute;
    const guard = this;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>, context: unknown) => {
        const previous = guard.dispatch;
        let release!: () => void;
        const lock = new Promise<void>((resolve) => {
          release = resolve;
        });
        guard.dispatch = previous.then(() => lock);
        await previous;
        try {
          return await guard.dispatchGuarded(execute, server, name, args, context);
        } finally {
          release();
        }
      },
    } as T;
  }

  private async dispatchGuarded(
    execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>,
    server: string,
    name: string,
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<unknown> {
    const { observations } = this.options;
    // 软时限：一切工具关闭，返回收尾提示（不抛错、不计失败）。
    if (this.pastSoftDeadline) {
      this.stats.blocked += 1;
      this.stats.softClosed = true;
      return { error: true, soft_closed: true, message: SOFT_DEADLINE_MESSAGE };
    }
    // 资源硬上限：防烧钱兜底（防的是失控，不指挥流程）。
    if (this.stats.attempts >= this.callLimit) {
      this.stats.blocked += 1;
      throw new Error(`本轮工具调用已达到 ${this.callLimit} 次上限，请用现有证据收尾`);
    }
    if (this.stats.failures >= this.failureLimit) {
      this.stats.blocked += 1;
      throw new Error(`本轮工具失败次数已达到 ${this.failureLimit} 次上限，请说明缺口并收尾`);
    }

    const signature = stableSignature(server, name, args);
    const cached = REUSABLE_TOOLS.has(name) ? this.cache.get(signature) : undefined;
    if (cached !== undefined) {
      const cachedRefs = typeof cached === 'object' && cached !== null && 'evidence_refs' in cached
        ? ((cached as { evidence_refs?: Array<{ id?: string }> }).evidence_refs ?? [])
        : [];
      const stale = cachedRefs.some((reference) => !reference.id || !observations.has(reference.id));
      if (!stale) {
        this.stats.cacheHits += 1;
        this.noteNoProgress(true);
        return this.maybeNudge(cached);
      }
    }
    if (this.failedSignatures.get(signature) === false) {
      this.stats.blocked += 1;
      throw new Error('同一调用签名已失败，禁止原样重试；请更换有依据的参数或报告证据缺口');
    }

    this.stats.attempts += 1;
    const retryingTransient = this.failedSignatures.get(signature) === true;
    try {
      const result = await execute(args, context);
      const navigationStatus = typeof result === 'object' && result !== null && 'status' in result
        ? (result as { status: unknown }).status
        : undefined;
      if (
        CODE_NAVIGATION_TOOLS.has(name) &&
        (isToolResultError(result) || ['unavailable', 'disabled', 'failed', 'error'].includes(String(navigationStatus)))
      ) {
        throw new Error(`代码导航失败，请回退到 search_project_text：${truncate(result)}`);
      }
      if (retryingTransient) this.failedSignatures.set(signature, false);

      let guided = result;
      if (['lookup_issue', 'get_knowledge_entry', 'search_knowledge'].includes(name)) {
        this.locators.register(result);
      }
      if (
        name === 'read_project_file' &&
        typeof args.relative_path === 'string' &&
        typeof result === 'object' && result !== null &&
        'start_line' in result && 'end_line' in result &&
        typeof result.start_line === 'number' && typeof result.end_line === 'number' &&
        result.end_line >= result.start_line
      ) {
        this.locators.markRead(args.relative_path, result.start_line, result.end_line);
      }
      if (name === 'search_project_text') {
        const hint = this.locators.hint(String(args.query ?? ''));
        if (hint) {
          guided = typeof result === 'object' && result !== null && !Array.isArray(result)
            ? { ...result, locator_hint: hint }
            : { matches: result, locator_hint: hint };
        }
      }

      const observed = observations.capture(name, args, guided);
      const observedResult = typeof observed === 'object' && observed !== null && 'result' in observed
        ? (observed as { result: unknown }).result
        : observed;

      const empty = observedResult === null || observedResult === '' ||
        (typeof observedResult === 'object' && observedResult !== null &&
          (('hits' in observedResult && Array.isArray((observedResult as { hits: unknown }).hits) &&
              (observedResult as { hits: unknown[] }).hits.length === 0) ||
            ('matches' in observedResult && Array.isArray((observedResult as { matches: unknown }).matches) &&
              (observedResult as { matches: unknown[] }).matches.length === 0)));
      const navigationKeys = CODE_NAVIGATION_TOOLS.has(name) ? navigationResultKeys(observedResult) : null;
      let noProgress =
        empty || navigationKeys?.size === 0 ||
        this.resultSignatures.has(resultFingerprint(name, observedResult));
      if (SEARCH_TOOLS.has(name) || navigationKeys !== null) {
        const keys = navigationKeys ?? searchResultKeys(observed);
        const previous = this.searchSeen.get(name) ?? new Set<string>();
        if (keys.size > 0 && [...keys].every((key) => previous.has(key))) noProgress = true;
        if (keys.size > 0) this.searchSeen.set(name, new Set([...previous, ...keys]));
      }
      this.noteNoProgress(noProgress);
      this.resultSignatures.add(resultFingerprint(name, observedResult));
      if (REUSABLE_TOOLS.has(name)) this.cache.set(signature, observed);
      return this.maybeNudge(observed);
    } catch (error) {
      this.stats.failures += 1;
      this.failedSignatures.set(signature, !retryingTransient && transientFailure(error));
      throw error;
    }
  }

  private noteNoProgress(noProgress: boolean): void {
    this.consecutiveNoProgress = noProgress ? this.consecutiveNoProgress + 1 : 0;
  }

  /** 连续无进展达到阈值时在结果里附提醒文本；不打断、不限制后续调用。 */
  private maybeNudge(result: unknown): unknown {
    if (this.consecutiveNoProgress < this.noProgressNudgeAt) return result;
    this.stats.nudges += 1;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return { ...result, round_guard_reminder: NO_PROGRESS_REMINDER };
    }
    return { result, round_guard_reminder: NO_PROGRESS_REMINDER };
  }
}
