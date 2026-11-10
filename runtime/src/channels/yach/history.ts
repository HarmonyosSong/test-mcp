/** Format group history rows for diagnosis prompt injection. */

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

export function summarizeGroupHistory(messages: unknown[], limit = 30): string {
  const lines: string[] = [];
  for (const item of messages.slice(-limit)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const content = messageText(row);
    if (!content) continue;
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
