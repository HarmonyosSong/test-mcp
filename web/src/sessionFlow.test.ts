import { conversationCreateInput, loadSessionState } from './sessionFlow';
import type { ChatConversation, ChatConversationSummary } from './types';

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function run() {
  equal(conversationCreateInput(), {}, 'new sessions let Runtime resolve source dynamically');

  const summaries = [
    { id: 'current', title: 'current' },
    { id: 'latest', title: 'latest' },
  ] as ChatConversationSummary[];
  const detail = (id: string) => ({
    id,
    title: id,
    messages: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }) as ChatConversation;
  let attempts = 0;
  const sessionApi = {
    async listConversations() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary list failure');
      return summaries;
    },
    async getConversation(id: string) {
      return detail(id);
    },
  };
  let retryFailed = false;
  try {
    await loadSessionState(sessionApi, 'current');
  } catch {
    retryFailed = true;
  }
  if (!retryFailed) throw new Error('a failed list request must be surfaced for retry');

  const refreshed = await loadSessionState(sessionApi, 'current');
  equal(refreshed.activeId, 'current', 'refresh preserves the active conversation');
  equal(refreshed.active?.id, 'current', 'refresh reloads the active conversation detail');
  const fallback = await loadSessionState({
    async listConversations() { return summaries.slice(1); },
    async getConversation(id) { return detail(id); },
  }, 'removed');
  equal(fallback.activeId, 'latest', 'refresh selects the newest conversation when active is gone');
  equal(fallback.active?.id, 'latest', 'fallback detail is loaded');
  console.log('sessionFlow tests passed');
}

void run();
