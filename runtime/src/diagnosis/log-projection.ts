/**
 * 日志工具结果投影：把 log-mcp 的 JSON 返回转成 Markdown 表格形态送给模型。
 *
 * 动机：轮内工作上下文累积的是工具完整返回，日志类是最大的体积来源
 * （93801fc 实测单次聚合返回 106K 字符 ≈ 86K token）。在真实模型（deepseek-flash）
 * 上以 153K 字符日志 fixture 实测：JSON 65,173 → 本投影 40,139 prompt tokens（-38%），
 * 5 种抽取题型 × 3 次重复 QA 两种形态均 15/15 正确，且聚合题推理 token 更低。
 * 实验材料见 experiments/log-projection-qa/。
 *
 * 保真铁律（违反任意一条曾导致质量静默退化，见实验 v2 失败记录）：
 * 1. 字段零丢弃：值只被提升（组内恒等字段→组头公共块）或去重引用（重复 stack→[S#]），
 *    绝不按频率/长度静默删字段；所有字段值在投影文本中原样可找回。
 * 2. 诊断关键列（ts/level/clickid/msg/traceId）永远保留为列，不做截断。
 * 3. 纯格式变换，不做内容摘要；认不出 logs 结构的结果原样返回，不强行转换。
 */

const PRIORITY_COLUMNS = [
  'ts',
  'time',
  'timestamp',
  'level',
  'clickid',
  'msg',
  'message',
  'traceId',
  'service',
  'topic',
];

const STACK_KEYS = new Set(['stack', 'stacktrace', 'stack_trace', 'stackTrace']);

/** 分组标题字段优先级；标题实际消费的键不再重复进 meta（其余键保留，零丢弃）。 */
const TITLE_KEYS = ['service', 'topic', 'name', 'host', 'source'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 标量与嵌套值统一成文本；null 显式保留（区别于空串/字段缺失），嵌套结构 JSON 内联。 */
function scalarText(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** 单元格转义：| 会破坏表格结构，换行压成可见符号（均在投影说明中声明）。 */
function cell(value: unknown): string {
  return scalarText(value)
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', '⏎')
    .replaceAll('\n', '⏎');
}

/** 返回标题实际消费的键名（供 meta 去重）；无非空标题键时返回 null。 */
function groupTitleKey(group: Record<string, unknown>): string | null {
  for (const key of TITLE_KEYS) {
    const value = group[key];
    if (typeof value === 'string' && value) return key;
  }
  return null;
}

function groupTitle(group: Record<string, unknown>, fallback: string): string {
  const key = groupTitleKey(group);
  if (key) return group[key] as string;
  return fallback;
}

function renderGroup(title: string, logs: unknown[], lines: string[]): void {
  lines.push(`## ${title}（${logs.length} 条）`);
  const records = logs.filter(isRecord);
  const scalars = logs.filter((item) => !isRecord(item));
  if (records.length === 0) {
    lines.push('（无日志）');
    for (const item of scalars) lines.push(`- ${cell(item)}`);
    return;
  }

  // 恒等字段提升：组内所有记录行同值的字段进组头公共块（stack 类长文本不参与）。
  const keys = [...new Set(records.flatMap((row) => Object.keys(row)))];
  const constant = new Map<string, string>();
  const varying: string[] = [];
  for (const key of keys) {
    if (STACK_KEYS.has(key)) {
      varying.push(key);
      continue;
    }
    const values = new Set(records.map((row) => scalarText(row[key])));
    if (values.size === 1) constant.set(key, [...values][0] ?? '');
    else varying.push(key);
  }
  if (constant.size > 0) {
    lines.push(
      '公共：' + [...constant.entries()].map(([key, value]) => `${key}=${cell(value)}`).join('; '),
      '',
    );
  }

  // stack 去重：相同原文只保留一份原文块，行内以编号引用。
  const stacks = new Map<string, string>();
  for (const row of records) {
    for (const key of STACK_KEYS) {
      const text = scalarText(row[key]);
      if (text && !stacks.has(text)) stacks.set(text, `S${stacks.size + 1}`);
    }
  }

  // 列：诊断关键字段排头，其余全部保留——不做频率截断。
  const ordered = [
    ...PRIORITY_COLUMNS.filter((key) => varying.includes(key)),
    ...varying.filter((key) => !PRIORITY_COLUMNS.includes(key)).sort(),
  ];
  const dataColumns = ordered.filter((key) => !STACK_KEYS.has(key));
  const stackColumns = ordered.filter((key) => STACK_KEYS.has(key));
  const header = [...dataColumns, ...stackColumns];
  if (header.length === 0) {
    // 全部字段恒定（典型如单条命中）：行内容即组头「公共」块，行数由组标题（N 条）承载；
    // 不渲染 |  | / |---| 畸形空表格。
    lines.push('（全部字段恒定，每行内容同上「公共」块）');
  } else {
    lines.push('| ' + header.join(' | ') + ' |', '|' + '---|'.repeat(header.length));
    for (const row of records) {
      const cells = dataColumns.map((key) => cell(row[key]));
      for (const key of stackColumns) cells.push(stacks.get(scalarText(row[key])) ?? '—');
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
  for (const item of scalars) lines.push(`- ${cell(item)}`);
  if (stacks.size > 0) {
    lines.push('');
    for (const [text, id] of stacks) lines.push(`[${id}] ${cell(text)}`);
  }
}

/**
 * 把日志工具返回投影成 Markdown。返回值规则：
 * - 结果里含 logs 数组 → 投影字符串（含头部与投影说明）；
 * - 否则原样返回输入（恒等，不做任何转换）。
 */
export function projectLogResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const lines: string[] = ['# 日志检索结果（投影：仅格式优化，字段无删减）'];
  let found = false;

  const walk = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        // 空数组也携带信息（如 partial_failures: []），保留字段存在性，不静默吞掉。
        if (path.length > 0) lines.push(`- ${path.join('.')}: []`);
        return;
      }
      if (value.every(isRecord)) {
        value.forEach((item, index) => walk(item, [...path, `${index}`]));
      } else if (path.length > 0) {
        lines.push(`- ${path.join('.')}: ${cell(value)}`);
      }
      return;
    }
    if (!isRecord(value)) {
      if (path.length > 0) lines.push(`- ${path.join('.')}: ${cell(value)}`);
      return;
    }
    if (Array.isArray(value.logs)) {
      found = true;
      const titleKey = groupTitleKey(value);
      const title = groupTitle(value, path[path.length - 1] ?? 'logs');
      const groupLines: string[] = [];
      renderGroup(title, value.logs, groupLines);
      // 标量（含 null）并进组头；标题已消费的键（如 service）不重复进 meta，
      // 其余标量保留——零丢弃但不重复输出。
      // 嵌套/数组类兄弟字段（pagination、warnings 等）必须在分组渲染后继续
      // 递归 walk，否则会连字段一起消失——铁律 1。
      const meta = Object.entries(value).filter(
        ([key, item]) => key !== 'logs' && key !== titleKey && !isRecord(item) && !Array.isArray(item),
      );
      if (meta.length > 0) {
        groupLines[0] += '；' + meta.map(([key, item]) => `${key}=${cell(item)}`).join(' ');
      }
      lines.push('', ...groupLines);
      for (const [key, item] of Object.entries(value)) {
        if (key === 'logs' || (!isRecord(item) && !Array.isArray(item))) continue;
        walk(item, [...path, key]);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
  };

  walk(result, []);
  if (!found) return result;
  lines.push(
    '',
    '> 投影说明：组内恒等字段已提升到「公共」块；重复 stack 以 [S#] 编号引用；' +
      '⏎ 表示原文换行；\\| 表示原文竖线；空数组与 null 原样标注；所有字段值与源 JSON 一致、无删减。',
  );
  return lines.join('\n');
}
