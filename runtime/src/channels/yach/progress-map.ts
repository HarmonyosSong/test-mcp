import type { DiagnosisStreamEvent } from '../../diagnosis/agent.js';

export function progressLabelForTool(toolName: string): string {
  const name = toolName.toLowerCase();
  if (
    name.includes('log_target')
    || name.includes('cloud_logs')
    || name.includes('log_catalog')
    || name.includes('logcenter')
  ) {
    return '正在查询远程日志';
  }
  if (
    name.includes('external')
    || name.includes('dev_knowledge')
    || name.includes('dev-knowledge')
  ) {
    return '正在查阅外部知识';
  }
  if (
    name.includes('repository')
    || name.includes('workspace')
    || name.includes('read_file')
    || name.includes('grep')
    || name.includes('list_dir')
    || name.includes('git_')
  ) {
    return '正在读取代码证据';
  }
  if (
    name.includes('knowledge')
    || name.includes('resolve_')
    || name.includes('search_')
    || name.includes('wiki')
  ) {
    return '正在查阅知识库';
  }
  return '正在收集证据';
}

export function progressLabelForStreamEvent(event: DiagnosisStreamEvent): string | null {
  if (event.type === 'tool-start') {
    return progressLabelForTool(event.event.tool);
  }
  if (event.type === 'text') return '正在生成诊断报告';
  if (event.type === 'completed') return '诊断完成';
  if (event.type === 'failed') return '诊断失败';
  return null;
}
