import type { ContactResolver } from '../channels/yach/contacts.js';
import type { UsageStatsResult } from './types.js';

/**
 * 聚合后修补：items 里 owner_display_name 为空的（历史会话、web local 身份），
 * 用知音楼通讯录把 owner_subject 工号翻译成姓名；查不到保持原值（表格兜底显示工号）。
 */
export async function resolveOwnerNames(
  stats: UsageStatsResult,
  resolver: ContactResolver,
): Promise<void> {
  const missing = new Set<string>();
  for (const item of stats.items) {
    if (!item.owner_display_name?.trim() && item.owner_subject?.trim()) {
      missing.add(item.owner_subject.trim());
    }
  }
  if (missing.size === 0) return;
  const names = await resolver.resolveNames([...missing]);
  for (const item of stats.items) {
    if (item.owner_display_name?.trim()) continue;
    const name = item.owner_subject?.trim() ? names.get(item.owner_subject.trim()) : undefined;
    if (name) item.owner_display_name = name;
  }
}
