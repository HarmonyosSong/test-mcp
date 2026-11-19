import type { DiagnosisStreamEvent } from '../../diagnosis/agent.js';
import { LOG_MCP_TOOL_NAMES } from '../../model/metadata.js';

const LOG_MCP_TOOL_NAME_SET = new Set<string>(LOG_MCP_TOOL_NAMES);

/**
 * 内部阶段分类：只用于把同类工具归到同一阶段、生成通俗进度文案。
 * 进度卡不展示固定任务清单（无 ○ 列表、无 x/y 计数），只推动态状态行。
 */
export type ProgressStepId = 'learner' | 'knowledge' | 'logs' | 'source' | 'consult' | 'report';

export function progressStepForTool(toolName: string): ProgressStepId | null {
  const name = toolName.toLowerCase();
  if (name.includes('lookup_learner') || name.includes('ucenter')) return 'learner';
  if (name.includes('prepare_source')) return 'source';
  if (name.includes('consult_compass')) return 'consult';
  if (LOG_MCP_TOOL_NAME_SET.has(toolName) || LOG_MCP_TOOL_NAME_SET.has(name)) return 'logs';
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

export function progressLabelForTool(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes('prepare_source')) return '正在绑定源码快照';
  if (name.includes('consult_compass')) return '正在请求服务端协查';
  const step = progressStepForTool(toolName);
  if (step === 'learner') return '正在查询学员信息';
  if (step === 'logs') return '正在查询远程日志';
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
