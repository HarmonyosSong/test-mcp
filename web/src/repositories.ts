import type { RepositoryRecord } from './types';

/** 登记或更新后按名称维护仓库列表，不修改 React 已有状态对象。 */
export function upsertRepository(
  current: RepositoryRecord[],
  repository: RepositoryRecord,
): RepositoryRecord[] {
  const exists = current.some((item) => item.id === repository.id);
  const next = exists
    ? current.map((item) => item.id === repository.id ? repository : item)
    : [...current, repository];
  return next.sort((left, right) => left.name.localeCompare(right.name));
}
