import { ModelConfiguration } from '../model/configuration.js';

export async function redactConfiguredError(filePath: string, error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  const configuration = new ModelConfiguration({ filePath });
  await configuration.initialize();
  return configuration.redact(message);
}
