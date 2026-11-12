import type {
  ChatConversation,
  ChatConversationSummary,
  CreateConversationInput,
} from './types';

export interface SessionListApi {
  listConversations: () => Promise<ChatConversationSummary[]>;
  getConversation: (id: string) => Promise<ChatConversation>;
}

export async function loadSessionState(api: SessionListApi, activeId: string | null) {
  const summaries = await api.listConversations();
  const selectedId = activeId && summaries.some((item) => item.id === activeId)
    ? activeId
    : summaries[0]?.id ?? null;
  const active = selectedId ? await api.getConversation(selectedId) : null;
  return { summaries, activeId: selectedId, active };
}

export function conversationCreateInput(): CreateConversationInput {
  return {};
}
