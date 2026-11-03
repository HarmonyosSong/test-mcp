import { resolve } from 'node:path';

import { z } from 'zod';

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === undefined || value === 'true');

export const runtimeConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8000),
  dataDir: z.string().default('.data/mastra'),
  databaseUrl: z.string().default(''),
  webDist: z.string().default('web/dist'),
  serveWeb: booleanFromEnv,
  legacyConversationsFile: z.string().default('.data/conversations.json'),
  legacyRepositoriesFile: z.string().default('.data/repositories.json'),
  legacySnapshotDir: z.string().default('.data/workspaces'),
  modelConfigFile: z.string().default('.data/model-config.json'),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const config = runtimeConfigSchema.parse({
    host: env.HARMONY_MASTRA_HOST,
    port: env.HARMONY_MASTRA_PORT,
    dataDir: env.HARMONY_MASTRA_DATA_DIR,
    databaseUrl: env.HARMONY_MASTRA_DATABASE_URL,
    webDist: env.HARMONY_MASTRA_WEB_DIST,
    serveWeb: env.HARMONY_MASTRA_SERVE_WEB,
    legacyConversationsFile: env.HARMONY_MASTRA_LEGACY_CONVERSATIONS_FILE,
    legacyRepositoriesFile: env.HARMONY_MASTRA_LEGACY_REPOSITORIES_FILE,
    legacySnapshotDir: env.HARMONY_MASTRA_LEGACY_SNAPSHOT_DIR,
    modelConfigFile: env.HARMONY_AGENT_MODEL_CONFIG_FILE,
  });
  return {
    ...config,
    databaseUrl: config.databaseUrl || `file:${resolve(config.dataDir, 'runtime.db')}`,
  };
}
