import { api } from '../api';
import type { RegisterRepositoryInput, RepositoryRecord } from '../types';

export interface RepositoryBindingTarget {
  name: string;
  url: string;
}

interface RepositoryMappingEntry {
  aliases: string[];
  name: string;
  url: string;
}

/** 固定仓库映射表：用户可在聊天中通过别名触发绑定。 */
const REPOSITORY_MAPPINGS: RepositoryMappingEntry[] = [
  {
    aliases: ['xesapp', '鸿蒙仓库', '学而思鸿蒙', '鸿蒙主仓库'],
    name: 'xesapp',
    url: 'https://git.100tal.com/peiyou_xueersi_harmony/xesapp.git',
  },
  {
    aliases: ['xesapp_pad', '鸿蒙 Pad', 'pad 仓库'],
    name: 'xesapp_pad',
    url: 'https://git.100tal.com/peiyou_xueersi_harmony/xesapp_pad.git',
  },
];

/** 根据用户输入检测是否包含绑定仓库意图，返回匹配到的仓库信息。 */
export function detectRepositoryBindingIntent(content: string): RepositoryBindingTarget | null {
  const text = content.trim().toLowerCase();
  if (!text.includes('绑定') && !text.includes('登记')) return null;

  for (const entry of REPOSITORY_MAPPINGS) {
    for (const alias of entry.aliases) {
      if (text.includes(alias.toLowerCase())) {
        return { name: entry.name, url: entry.url };
      }
    }
  }

  return null;
}

/** 向后端登记指定仓库。 */
export async function registerRepositoryByName(
  target: RepositoryBindingTarget,
): Promise<RepositoryRecord> {
  const input: RegisterRepositoryInput = {
    name: target.name,
    url: target.url,
  };
  return api.registerRepository(input);
}
