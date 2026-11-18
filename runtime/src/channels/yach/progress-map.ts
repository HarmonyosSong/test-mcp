import type { DiagnosisStreamEvent } from '../../diagnosis/agent.js';
import { LOG_MCP_TOOL_NAMES } from '../../model/metadata.js';

const LOG_MCP_TOOL_NAME_SET = new Set<string>(LOG_MCP_TOOL_NAMES);

/** 固定任务清单；知音楼进度卡按此顺序勾选。 */
export const PROGRESS_STEPS = [
  { id: 'learner', title: '查询学员信息' },
  { id: 'knowledge', title: '查阅产品知识' },
  { id: 'logs', title: '检索线上日志' },
  { id: 'source', title: '核对源码线索' },
  { id: 'consult', title: '服务端协查' },
  { id: 'report', title: '整理结论' },
] as const;

export type ProgressStepId = (typeof PROGRESS_STEPS)[number]['id'];

export type ProgressStepState = 'pending' | 'active' | 'done';

export type ProgressChecklist = Record<ProgressStepId, ProgressStepState>;

export function createProgressChecklist(): ProgressChecklist {
  return {
    learner: 'pending',
    knowledge: 'pending',
    logs: 'pending',
    source: 'pending',
    consult: 'pending',
    report: 'pending',
  };
}

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

export function applyProgressEvent(
  checklist: ProgressChecklist,
  event: DiagnosisStreamEvent,
): { checklist: ProgressChecklist; label: string | null; changed: boolean } {
  const next = { ...checklist };
  let label: string | null = null;
  let changed = false;

  const activate = (id: ProgressStepId, text: string) => {
    label = text;
    if (next[id] === 'done') return;
    if (next[id] !== 'active') {
      next[id] = 'active';
      changed = true;
    }
  };

  const complete = (id: ProgressStepId) => {
    if (next[id] !== 'done') {
      next[id] = 'done';
      changed = true;
    }
  };

  if (event.type === 'tool-start') {
    const step = progressStepForTool(event.event.tool);
    label = progressLabelForTool(event.event.tool);
    if (step) activate(step, label);
  } else if (event.type === 'tool-end') {
    const step = progressStepForTool(event.event.tool);
    if (step) complete(step);
    label = null;
  } else if (event.type === 'text') {
    activate('report', '正在整理结论');
  } else if (event.type === 'completed') {
    for (const step of PROGRESS_STEPS) {
      if (next[step.id] === 'active') complete(step.id);
    }
    complete('report');
    label = '诊断完成';
  } else if (event.type === 'failed') {
    activate('report', '诊断失败');
    label = '诊断失败';
  }

  return { checklist: next, label, changed };
}

export function renderProgressChecklist(
  checklist: ProgressChecklist,
  currentLabel: string | null,
  elapsedSeconds: number,
): string {
  const done = PROGRESS_STEPS.filter((step) => checklist[step.id] === 'done').length;
  const total = PROGRESS_STEPS.length;
  const lines = [
    '**任务进度**',
    '',
    `已完成 ${done}/${total} 项`,
    '',
  ];
  for (const step of PROGRESS_STEPS) {
    const state = checklist[step.id];
    const mark = state === 'done' ? '✓' : state === 'active' ? '→' : '○';
    const suffix = state === 'active' && currentLabel ? `（进行中）` : '';
    lines.push(`${mark} ${step.title}${suffix}`);
  }
  if (currentLabel) {
    lines.push('', `- ${currentLabel}（${elapsedSeconds} 秒）`);
  }
  return lines.join('\n');
}

export function progressLabelForStreamEvent(event: DiagnosisStreamEvent): string | null {
  return applyProgressEvent(createProgressChecklist(), event).label;
}
