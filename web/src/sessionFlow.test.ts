import { conversationCreateInput, loadRepositoryBranches, loadSessionState } from './sessionFlow';
import type { ChatConversation, ChatConversationSummary, RepositoryBranch, RepositoryRecord } from './types';

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function run() {
  equal(conversationCreateInput('', ''), {}, 'unbound sessions omit repository fields');
  equal(conversationCreateInput('repo-1', 'feature/login'), {
    repository_id: 'repo-1', branch: 'feature/login',
  }, 'repository sessions include the selected repository and branch');

  const repositories = [{ id: 'repo-1', default_branch: 'main' }] as RepositoryRecord[];
  const branches = [{ name: 'feature/login', commit: 'a' }, { name: 'main', commit: 'b' }] as RepositoryBranch[];
  const selected = await loadRepositoryBranches('repo-1', repositories, async (id) => {
    equal(id, 'repo-1', 'branch lookup uses the selected repository');
    return branches;
  });
  equal(selected.selectedBranch, 'main', 'branch lookup prefers the registered default');

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
