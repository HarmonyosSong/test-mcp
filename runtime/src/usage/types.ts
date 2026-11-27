/** Usage stats module types (independent of chat channels). */

export type UsageFeedbackVerdict = 'correct' | 'vague' | 'failed' | 'none';

export interface UsageStatsSummary {
  unique_users: number;
  conversations: number;
  user_messages: number;
  with_verdict: number;
  feedback: {
    correct: number;
    vague: number;
    failed: number;
    none: number;
  };
}

export interface UsageStatsItem {
  conversation_id: string;
  channel: 'web' | 'yach_im';
  owner_subject: string | null;
  owner_display_name: string | null;
  question: string;
  verdict: string | null;
  conclusion_excerpt: string | null;
  feedback: UsageFeedbackVerdict;
  feedback_by: string | null;
  at: string;
}

export interface UsageStatsResult {
  /** Inclusive range start (YYYY-MM-DD). */
  from: string;
  /** Inclusive range end (YYYY-MM-DD). */
  to: string;
  /**
   * Single-day alias when from === to (日报用)；多日时为 `from~to`。
   */
  date: string;
  /** Echo of request preset when provided (today|yesterday|3d|7d|30d). */
  range: string | null;
  timezone: string;
  summary: UsageStatsSummary;
  items: UsageStatsItem[];
}
