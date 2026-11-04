const SECRET_ENV_NAME = /(key|token|secret|password|credential|authorization)/i;

export function redactSensitiveText(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  for (const [name, secret] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(name) || !secret || secret.length < 4) continue;
    result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]');
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
