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
  date: string;
  timezone: string;
  summary: UsageStatsSummary;
  items: UsageStatsItem[];
}
