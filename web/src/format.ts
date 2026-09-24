export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 花费估算（元）：价格表按模型取，缓存折扣/套餐价不含在内；无价格数据时返回 null。 */
export function estimateCost(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  modelName: string,
  prices: Record<string, { input: number; output: number }>,
): number | null {
  const price = prices[modelName];
  if (!price || inputTokens == null) return null;
  return (inputTokens / 1_000_000) * price.input + ((outputTokens ?? 0) / 1_000_000) * price.output;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `¥${cost.toFixed(4)}`;
  if (cost < 1) return `¥${cost.toFixed(3)}`;
  return `¥${cost.toFixed(2)}`;
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
