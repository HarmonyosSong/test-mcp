import type { ConversationRecord } from '../domain/schemas.js';
import { isFaultFinalAnswer } from '../channels/yach/archive.js';
import { parseVerdictMarker } from '../diagnosis/final-answer-validator.js';
import { isInstantInDay } from './day.js';
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
 * Aggregate daily usage from product conversations (Web + 知音楼).
 * A conversation counts if it has ≥1 user message whose created_at falls on dateYmd in timezone.
 */
export function aggregateUsageStats(
  conversations: ConversationRecord[],
  dateYmd: string,
  timeZone: string,
): UsageStatsResult {
  const users = new Set<string>();
  let userMessages = 0;
  let withVerdict = 0;
  const feedback = { correct: 0, vague: 0, failed: 0, none: 0 };
  const items: UsageStatsItem[] = [];

  for (const conversation of conversations) {
    const dayUserMessages = conversation.messages.filter(
      (message) => message.role === 'user' && isInstantInDay(message.created_at, dateYmd, timeZone),
    );
    if (dayUserMessages.length === 0) continue;

    userMessages += dayUserMessages.length;
    if (conversation.owner_subject) users.add(conversation.owner_subject);

    const questionSource = dayUserMessages[0]!;
    const question = truncate(questionSource.content || conversation.title || '(无正文)', QUESTION_MAX);

    // Prefer fault final answers with 判定；else any assistant with verdict marker (same day or later that day).
    let conclusionMsg = null as (typeof conversation.messages)[number] | null;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index]!;
      if (message.role !== 'assistant' || message.status !== 'completed') continue;
      if (!isInstantInDay(message.created_at, dateYmd, timeZone)) continue;
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
    date: dateYmd,
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
