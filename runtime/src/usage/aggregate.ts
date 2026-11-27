import type { ConversationRecord } from '../domain/schemas.js';
import { isFaultFinalAnswer } from '../channels/yach/archive.js';
import { parseVerdictMarker } from '../diagnosis/final-answer-validator.js';
import { isInstantInRange } from './day.js';
import type { UsageFeedbackVerdict, UsageStatsItem, UsageStatsResult } from './types.js';

const QUESTION_MAX = 200;
const CONCLUSION_MAX = 280;

const VERDICT_LABEL: Record<string, string> = {
  located: '已定位',
  probable: '可能定位',
  insufficient_evidence: '证据不足',
  tool_error: '工具异常',
  info_lookup: '信息查询',
};

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function extractVerdictLabel(content: string): string | null {
  const marker = parseVerdictMarker(content);
  if (!marker) return null;
  return VERDICT_LABEL[marker] ?? marker;
}

/**
 * Aggregate usage for an inclusive calendar-day range (Web + 知音楼).
 * A conversation counts if it has ≥1 user message in [fromYmd, toYmd].
 */
export function aggregateUsageStats(
  conversations: ConversationRecord[],
  fromYmd: string,
  toYmd: string,
  timeZone: string,
): UsageStatsResult {
  const from = fromYmd <= toYmd ? fromYmd : toYmd;
  const to = fromYmd <= toYmd ? toYmd : fromYmd;
  const users = new Set<string>();
  let userMessages = 0;
  let withVerdict = 0;
  const feedback = { correct: 0, vague: 0, failed: 0, none: 0 };
  const items: UsageStatsItem[] = [];

  for (const conversation of conversations) {
    const rangeUserMessages = conversation.messages.filter(
      (message) =>
        message.role === 'user' && isInstantInRange(message.created_at, from, to, timeZone),
    );
    if (rangeUserMessages.length === 0) continue;

    userMessages += rangeUserMessages.length;
    if (conversation.owner_subject) users.add(conversation.owner_subject);

    const questionSource = rangeUserMessages[0]!;
    const question = truncate(questionSource.content || conversation.title || '(无正文)', QUESTION_MAX);

    let conclusionMsg = null as (typeof conversation.messages)[number] | null;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index]!;
      if (message.role !== 'assistant' || message.status !== 'completed') continue;
      if (!isInstantInRange(message.created_at, from, to, timeZone)) continue;
      if (!parseVerdictMarker(message.content)) continue;
      if (isFaultFinalAnswer(message.content)) {
        conclusionMsg = message;
        break;
      }
      if (!conclusionMsg) conclusionMsg = message;
    }

    const verdict = conclusionMsg ? extractVerdictLabel(conclusionMsg.content) : null;
    if (verdict) withVerdict += 1;

    let feedbackVerdict: UsageFeedbackVerdict = 'none';
    let feedbackBy: string | null = null;
    const archived = conclusionMsg?.analysis_feedback;
    if (archived) {
      feedbackVerdict = archived.verdict;
      feedbackBy = archived.by_name || archived.by_work_code || null;
      if (archived.verdict === 'correct') feedback.correct += 1;
      else if (archived.verdict === 'vague') feedback.vague += 1;
      else feedback.failed += 1;
    } else {
      feedback.none += 1;
    }

    items.push({
      conversation_id: conversation.id,
      channel: conversation.channel ?? 'web',
      owner_subject: conversation.owner_subject ?? null,
      owner_display_name: conversation.owner_display_name ?? null,
      question,
      verdict,
      conclusion_excerpt: conclusionMsg
        ? truncate(conclusionMsg.content, CONCLUSION_MAX)
        : null,
      feedback: feedbackVerdict,
      feedback_by: feedbackBy,
      at: questionSource.created_at,
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    from,
    to,
    date: from === to ? from : `${from}~${to}`,
    range: null,
    timezone: timeZone,
    summary: {
      unique_users: users.size,
      conversations: items.length,
      user_messages: userMessages,
      with_verdict: withVerdict,
      feedback,
    },
    items,
  };
}

/** Single calendar day (日报). */
export function aggregateUsageStatsForDay(
  conversations: ConversationRecord[],
  dateYmd: string,
  timeZone: string,
): UsageStatsResult {
  return aggregateUsageStats(conversations, dateYmd, dateYmd, timeZone);
}
