import type { ChatMessage } from '../../domain/schemas.js';

/**
 * 问题归档（知音楼）：故障终稿末尾挂「问题分析正确/失败」快捷回复链接，
 * 支持老师点击后发出对应文本，入站识别后回写到最近一条故障终稿消息上，
 * 供「谁用了、分析正确率多少」的评测统计。
 */

/** 归档结论三档：正确 / 模糊（方向对但不够具体）/ 失败。 */
export type ArchiveVerdict = 'correct' | 'vague' | 'failed';

/** 归档反馈文本 → 归档结论。精确匹配（trim 后），避免把正常提问误判成归档。 */
export function parseArchiveFeedback(text: string): ArchiveVerdict | null {
  const trimmed = text.trim();
  if (trimmed === '问题分析正确') return 'correct';
  if (trimmed === '问题分析模糊') return 'vague';
  if (trimmed === '问题分析失败') return 'failed';
  return null;
}

/** 知音楼快捷回复链接：点击后发送 reply 指定的文本（语法由知音楼机器人平台定义）。 */
function archiveLink(label: string): string {
  return `[${label}](yach://yach.zhiyinlou.com/session/robot?type=fold&extra={}&reply=${label})`;
}

/** 归档区正文：三个选项并排（正确 / 模糊 / 失败）。 */
export const ARCHIVE_SECTION = `**【问题归档】**\n${archiveLink('问题分析正确')}　${archiveLink('问题分析模糊')}　${archiveLink('问题分析失败')}`;

/**
 * 故障排查终稿判定：含「判定：已定位|可能定位|证据不足|工具异常」锚点且不标「（初步）」。
 * 锚点与 parseVerdictMarker 同口径（不限行首，句中出现也算——模型可能把判定揉进段落），
 * 避免出现「统计有结论但不可归档」的口径裂缝。
 * 信息查询（查学员）与初步判定（协查在途）都不是终稿，不挂归档、也不作为归档回写目标。
 */
const FINAL_VERDICT_PATTERN = /判定\s*[:：]\s*(已定位|可能定位|证据不足|工具异常)(?!\s*[（(]\s*初步)/;

export function isFaultFinalAnswer(content: string): boolean {
  return FINAL_VERDICT_PATTERN.test(content);
}

/** 给终稿正文追加「问题归档」区（仅在出站时追加，不落库）。
 *  整体受 IM 长度上限约束：正文超长时先裁正文，归档区始终保留。 */
export function appendArchiveSection(body: string, messageLimit: number): string {
  const truncatedSuffix = '\n…（已截断）';
  const budget = Math.max(0, messageLimit - ARCHIVE_SECTION.length - 2 - truncatedSuffix.length);
  const trimmed = body.length > budget ? `${body.slice(0, budget).trimEnd()}${truncatedSuffix}` : body;
  return `${trimmed}\n\n${ARCHIVE_SECTION}`;
}

/** 归档确认回执文案。 */
export function archiveAckText(verdict: ArchiveVerdict): string {
  if (verdict === 'correct') return '已记录归档：问题分析正确，感谢反馈。';
  if (verdict === 'vague') return '已记录归档：问题分析模糊，感谢反馈，我们会争取写得更具体。';
  return '已记录归档：问题分析失败，感谢反馈，我们会复盘改进。';
}

/** 在会话消息里找归档回写目标：最近一条故障终稿 assistant 消息（从后往前）。 */
export function findArchivableMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && isFaultFinalAnswer(message.content)) return message;
  }
  return null;
}
