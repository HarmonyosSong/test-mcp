import type { ConversationRecord, SourceRepositoryBinding } from '../domain/schemas.js';

type SourceBindingState = Pick<
  ConversationRecord,
  | 'workspace_path'
  | 'repository_id'
  | 'repository_name'
  | 'requested_ref'
  | 'resolved_commit'
  | 'source_repositories'
  | 'source_completeness'
  | 'source_limitations'
>;

/** A source workspace is usable only after Runtime has recorded its identity. */
export function hasCompleteSourceBinding(value: SourceBindingState): boolean {
  if (!value.workspace_path || !value.repository_id || !value.resolved_commit) return false;
  const repositories = value.source_repositories ?? [];
  // Active Runtime bindings always carry the shell entry (and any mounted
  // components) so legacy workspace-only records cannot re-enter the product path.
  if (repositories.length === 0) return false;

  const shell = repositories.find((repository) => repository.role === 'shell');
  return Boolean(
    shell &&
    shell.repository_id === value.repository_id &&
    shell.resolved_commit === value.resolved_commit &&
    repositories.every(validRepositoryBinding),
  );
}

export function clearIncompleteSourceBinding(value: SourceBindingState): void {
  if (hasCompleteSourceBinding(value)) return;
  value.workspace_path = null;
  value.repository_id = null;
  value.repository_name = null;
  value.requested_ref = null;
  value.resolved_commit = null;
  value.source_repositories = [];
  value.source_completeness = null;
  value.source_limitations = [];
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
