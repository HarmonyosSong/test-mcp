import type { DiagnosisStreamEvent } from '../../diagnosis/agent.js';
import { LOG_MCP_TOOL_NAMES } from '../../model/metadata.js';

const LOG_MCP_TOOL_NAME_SET = new Set<string>(LOG_MCP_TOOL_NAMES);

/**
 * 内部阶段分类：只用于把同类工具归到同一阶段、生成通俗进度文案。
 * 进度卡不展示固定任务清单（无 ○ 列表、无 x/y 计数），只推动态状态行。
 */
export type ProgressStepId = 'learner' | 'knowledge' | 'logs' | 'source' | 'consult' | 'report';

/**
 * 日志来源分档：log-mcp 的返回体本身带 `source` 字段，但进度事件只拿得到工具名，
 * 所以按工具名还原来源——`cloud_*` 走阿里云 SLS，其余日志工具走日志中心（ES/Lucene），
 * `search_both_logs` 两侧并行。
 */
export type LogSourceKind = 'logcenter' | 'cloud' | 'both';

/** 聚合工具名（唯一同时命中两侧的工具）。 */
const LOG_BOTH_TOOL_NAME = 'search_both_logs';
/** 云日志（阿里云 SLS）工具名前缀。 */
const CLOUD_LOG_TOOL_PREFIX = 'cloud_';

/** log-mcp 工具名可能带的服务前缀（`log.query` / `log_cloud_search`）。 */
const LOG_SERVER_PREFIXES = new Set(['log', 'log-mcp', 'log_mcp', 'logserve', 'log-server']);

/**
 * 把可能带服务前缀的工具名还原成 log-mcp 裸工具名。
 * 只认白名单前缀，避免 `repository_count` 这类别的 MCP 的通用后缀被误判成日志工具。
 */
function canonicalLogToolName(toolName: string): string | null {
  const raw = toolName.toLowerCase().trim();
  const base = raw.split('.').pop() ?? '';
  if (LOG_MCP_TOOL_NAME_SET.has(base)) return base;
  // `log_cloud_count` 形式：按最长后缀匹配，避免 `_count` 抢先命中。
  for (const prefix of LOG_SERVER_PREFIXES) {
    if (!base.startsWith(`${prefix}_`)) continue;
    const rest = base.slice(prefix.length + 1);
    if (LOG_MCP_TOOL_NAME_SET.has(rest)) return rest;
  }
  return null;
}

/** 判断该工具查的是哪一侧日志；非日志工具返回 null。 */
export function logSourceForTool(toolName: string): LogSourceKind | null {
  const name = canonicalLogToolName(toolName);
  if (!name) return null;
  if (name === LOG_BOTH_TOOL_NAME) return 'both';
  return name.startsWith(CLOUD_LOG_TOOL_PREFIX) ? 'cloud' : 'logcenter';
}

export function progressStepForTool(toolName: string): ProgressStepId | null {
  const name = toolName.toLowerCase();
  if (name.includes('lookup_learner') || name.includes('ucenter')) return 'learner';
  if (name.includes('prepare_source')) return 'source';
  if (name.includes('consult_compass') || name.includes('compass_followup')) return 'consult';
  if (canonicalLogToolName(toolName)) return 'logs';
  if (
    name.includes('repository')
    || name.includes('workspace')
    || name.includes('read_file')
    || name.includes('read_project')
    || name.includes('search_project')
    || name.includes('search_code')
    || name.includes('code_outline')
    || name.includes('trace_code')
    || name.includes('list_project')
    || name.includes('list_dir')
    || name.includes('git_')
  ) {
    return 'source';
  }
  if (
    name.includes('knowledge')
    || name.includes('lookup_issue')
    || name.includes('load_skill')
    || name.includes('wiki')
  ) {
    return 'knowledge';
  }
  return null;
}

/** 日志阶段文案：按来源分档，让群里支持老师看清查的是哪套日志。 */
function logProgressLabel(source: LogSourceKind | null): string {
  if (source === 'cloud') return '正在查询阿里云 SLS 日志';
  if (source === 'both') return '正在同时查询日志中心与云日志';
  if (source === 'logcenter') return '正在查询日志中心';
  return '正在查询远程日志';
}

export function progressLabelForTool(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes('prepare_source')) return '正在绑定源码快照';
  if (name.includes('compass_followup')) return '已发起服务端协查（后台跟进）';
  if (name.includes('consult_compass')) return '正在请求服务端协查';
  const step = progressStepForTool(toolName);
  if (step === 'learner') return '正在查询学员信息';
  if (step === 'logs') return logProgressLabel(logSourceForTool(toolName));
  if (step === 'source') return '正在读取代码证据';
  if (step === 'knowledge') return '正在查阅知识库';
  if (step === 'consult') return '正在请求服务端协查';
  if (step === 'report') return '正在整理结论';
  return '正在收集证据';
}

/**
 * 把诊断流事件翻译成一条动态进度文案。
 * 工具开始 → 该工具对应的进行中文案；正文开始输出 → 正在整理结论；异常 → 诊断失败。
 * 返回 null 表示该事件不产生进度文案（如工具结束）。
 */
export function progressLabelForStreamEvent(event: DiagnosisStreamEvent): string | null {
  if (event.type === 'tool-start') return progressLabelForTool(event.event.tool);
  if (event.type === 'text') return '正在整理结论';
  if (event.type === 'failed') return '诊断失败';
  return null;
}
