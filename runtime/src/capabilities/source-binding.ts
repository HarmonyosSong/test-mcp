import type { ConversationRecord, SourceRepositoryBinding } from '../domain/schemas.js';

type SourceBindingState = Pick<
  ConversationRecord,
  'workspace_path' | 'repository_id' | 'resolved_commit' | 'source_repositories'
>;

/** A source workspace is usable only after Runtime has recorded its identity. */
export function hasCompleteSourceBinding(value: SourceBindingState): boolean {
  if (!value.workspace_path || !value.repository_id || !value.resolved_commit) return false;
  const repositories = value.source_repositories ?? [];
  if (repositories.length === 0) return true;

  const shell = repositories.find((repository) => repository.role === 'shell');
  return Boolean(
    shell &&
    shell.repository_id === value.repository_id &&
    shell.resolved_commit === value.resolved_commit &&
    repositories.every(validRepositoryBinding),
  );
}

function validRepositoryBinding(value: SourceRepositoryBinding): boolean {
  return Boolean(
    value.repository_id &&
    value.repository_name &&
    value.requested_ref &&
    value.resolved_commit &&
    value.role &&
    typeof value.mount_path === 'string',
  );
}
