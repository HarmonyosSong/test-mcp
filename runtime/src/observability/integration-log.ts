/** Lightweight integration diagnostics for packaged/production deploys. Never log secrets. */

export type IntegrationChannel = 'sso' | 'ucenter' | 'a2a' | 'auth' | 'yach';

function stamp(channel: IntegrationChannel): string {
  return `[integration:${channel}]`;
}

export function integrationInfo(channel: IntegrationChannel, message: string, detail?: Record<string, unknown>): void {
  if (detail && Object.keys(detail).length > 0) {
    console.log(stamp(channel), message, detail);
  } else {
    console.log(stamp(channel), message);
  }
}

export function integrationWarn(channel: IntegrationChannel, message: string, detail?: Record<string, unknown>): void {
  if (detail && Object.keys(detail).length > 0) {
    console.warn(stamp(channel), message, detail);
  } else {
    console.warn(stamp(channel), message);
  }
}

export function integrationError(
  channel: IntegrationChannel,
  message: string,
  error?: unknown,
  detail?: Record<string, unknown>,
): void {
  const err =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : error === undefined
        ? undefined
        : { message: String(error) };
  console.error(stamp(channel), message, { ...detail, ...(err ? { error: err } : {}) });
}
