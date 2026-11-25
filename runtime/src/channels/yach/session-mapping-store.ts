import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 群/私聊 → 会话 ID 映射的落盘持久化。
 * 进程重启后内存映射丢失，同群同学员的追问会被开成新会话、丢掉排查上下文；
 * 写穿到 JSON 文件后重启仍能找回。映射只是体验优化：读写失败一律静默，不阻断诊断。
 */
export interface SessionMappingStore {
  get(key: string): string | undefined;
  set(key: string, conversationId: string): void;
}

export function createSessionMappingStore(file: string): SessionMappingStore {
  const map = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' && value) map.set(key, value);
      }
    }
  } catch {
    // 文件不存在或损坏：从空映射开始。
  }

  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // 写失败不阻断：内存映射本轮仍有效，只是重启后回退到旧文件。
    }
  };

  return {
    get: (key) => map.get(key),
    set: (key, conversationId) => {
      map.set(key, conversationId);
      persist();
    },
  };
}
