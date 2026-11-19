/** Format group history rows for diagnosis prompt injection. */

export interface GroupHistoryOptions {
  limit?: number;
  /** 机器人自身在群里的显示名（可多个），其消息不进上下文。 */
  excludeSenders?: string[];
}

/** 机器人自身消息的内容特征：终态回复以「判定：」锚点开头、进度/失败/会话控制类有固定前缀。
 *  错误转储（AI_APICallError 等）无论谁发的都不进 prompt。 */
const BOT_CONTENT_PATTERNS: RegExp[] = [
  /^判定\s*[:：]/,
  /^(诊断失败|诊断完成|任务进度|已开启新的诊断会话|已取消)/,
  /AI_APICallError|"stack"\s*:|\\n\s*at \(/,
];

function messageText(row: Record<string, unknown>): string {
  if (typeof row.content === 'string' && row.content.trim()) return row.content.trim();
  if (typeof row.text === 'string' && row.text.trim()) return row.text.trim();
  if (row.content && typeof row.content === 'object') {
    const nested = row.content as Record<string, unknown>;
    if (typeof nested.text === 'string' && nested.text.trim()) return nested.text.trim();
    if (typeof nested.content === 'string' && nested.content.trim()) return nested.content.trim();
  }
  return '';
}

function senderLabel(row: Record<string, unknown>): string {
  if (typeof row.senderName === 'string' && row.senderName.trim()) return row.senderName.trim();
  if (typeof row.sender_name === 'string' && row.sender_name.trim()) return row.sender_name.trim();
  if (typeof row.senderNick === 'string' && row.senderNick.trim()) return row.senderNick.trim();
  if (typeof row.name === 'string' && row.name.trim()) return row.name.trim();
  if (typeof row.workCode === 'string' && row.workCode.trim()) return row.workCode.trim();
  return '成员';
}

export function summarizeGroupHistory(messages: unknown[], options: GroupHistoryOptions = {}): string {
  const { limit = 30, excludeSenders = [] } = options;
  const excluded = new Set(excludeSenders.map((name) => name.trim()).filter(Boolean));
  const lines: string[] = [];
  for (const item of messages.slice(-limit)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (excluded.has(senderLabel(row))) continue;
    const content = messageText(row);
    if (!content) continue;
    if (BOT_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) continue;
    lines.push(`${senderLabel(row)}: ${content.slice(0, 200)}`);
  }
  return lines.join('\n');
}

export function buildGroupDiagnosisContent(question: string, historySummary: string): string {
  if (!historySummary.trim()) return question;
  return [
    '下面是本群近 24 小时内通过开放平台拉取的群聊记录摘要，请优先据此回答与群消息相关的问题。',
    '',
    '【群聊近期上下文】',
    historySummary.trim(),
    '',
    '【当前提问】',
    question,
  ].join('\n');
}
