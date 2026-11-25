import { readFileSync } from 'node:fs';

/**
 * 读取代码索引版本窗口（code-index/version-scope.json），生成 prompt 用的窗口描述。
 * 与索引服务端加载的是同一个文件：窗口随版本登记演进，prompt 不再硬编码会过期的版本号。
 * 读不到/格式异常返回 null，调用方回退为不含具体版本号的通用描述。
 */
export function loadCodeIndexScopeSummary(scopeFile: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(scopeFile, 'utf8')) as Record<string, unknown>;
    const asList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    const defaults = asList(raw.default);
    if (defaults.length === 0) return null;
    const hdOnly = asList(raw.hd).filter((version) => !defaults.includes(version));
    const hdPart = hdOnly.length > 0 ? `，HD 窗口另含 ${hdOnly.join('/')}` : '';
    return `默认窗口覆盖 ${defaults.join('/')}${hdPart}`;
  } catch {
    return null;
  }
}
