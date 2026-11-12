import type {
  ChatConversation,
  ChatConversationSummary,
  CreateConversationInput,
  RepositoryBranch,
  RepositoryRecord,
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

export async function loadRepositoryBranches(
  repositoryId: string,
  repositories: RepositoryRecord[],
  fetchBranches: (id: string) => Promise<RepositoryBranch[]>,
) {
  const branches = await fetchBranches(repositoryId);
  const preferred = branches.find((item) =>
    item.name === repositories.find((repository) => repository.id === repositoryId)?.default_branch,
  ) ?? branches[0];
  return { branches, selectedBranch: preferred?.name ?? '' };
}

export function conversationCreateInput(
  repositoryId: string,
  branch: string,
): CreateConversationInput {
  if (!repositoryId) return {};
  if (!branch) throw new Error('请选择诊断分支。');
  return { repository_id: repositoryId, branch };
}
