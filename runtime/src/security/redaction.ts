/**
 * 不脱敏（2026-11-13 用户决定）：全链路内网协作排查，文本一律原样返回，
 * 包括 Bearer 凭证、URL 密钥参数与环境变量密钥值。
 * 函数边界保留，便于未来需要时恢复脱敏策略。
 */
export function redactSensitiveText(value: string, _env: NodeJS.ProcessEnv = process.env): string {
  return value;
}

export function redactRecord<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactRecord(item, redact)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redact(key), redactRecord(item, redact)]),
  ) as T;
}

export function redactRecordInPlace<T>(value: T, redact: (text: string) => string): T {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = redactRecordInPlace(value[index], redact);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const safeKey = redact(key);
      const safeItem = redactRecordInPlace(item, redact);
      if (safeKey !== key) delete (value as Record<string, unknown>)[key];
      (value as Record<string, unknown>)[safeKey] = safeItem;
    }
  } else if (typeof value === 'string') {
    return redact(value) as T;
  }
  return value;
}
