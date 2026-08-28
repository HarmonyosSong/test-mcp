import type {
  CaseStatus,
  DiagnosticCase,
  DiagnosticStageKey,
  StageStatus,
} from './types';

const stageLabels: Record<DiagnosticStageKey, string> = {
  intake: '问题受理',
  locate: '找到问题',
  investigate: '排查问题',
  diagnose: '给出诊断',
};

const caseStatusLabels: Record<CaseStatus, string> = {
  queued: '排队中',
  running: '诊断中',
  completed: '已完成',
  failed: '失败',
};

const stageStatusLabels: Record<StageStatus, string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
};

export function stageLabel(stage: DiagnosticStageKey): string {
  return stageLabels[stage] || stage;
}

export function currentStage(diagnosticCase: DiagnosticCase): DiagnosticStageKey {
  const running = diagnosticCase.stages.find((stage) => stage.status === 'running');
  if (running) return running.key;
  const pending = diagnosticCase.stages.find((stage) => stage.status === 'pending');
  if (pending) return pending.key;
  return diagnosticCase.stages.at(-1)?.key || 'intake';
}

export function caseStatusLabel(status: CaseStatus): string {
  return caseStatusLabels[status] || status;
}

export function stageStatusLabel(status: StageStatus): string {
  return stageStatusLabels[status] || status;
}

export function formatDate(value?: string | null): string {
  if (!value) return '未开始';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDuration(start?: string | null, end?: string | null): string {
  if (!start) return '';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return '';
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export function severityLabel(value: string): string {
  const labels: Record<string, string> = {
    critical: '严重',
    high: '高',
    medium: '中',
    low: '低',
    info: '提示',
  };
  return labels[value.toLowerCase()] || value;
}
