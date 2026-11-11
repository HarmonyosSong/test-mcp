import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === 'true');

function findRepositoryRoot(): string {
  let directory = resolve(fileURLToPath(new URL('.', import.meta.url)));
  while (true) {
    if (existsSync(resolve(directory, 'skills')) && existsSync(resolve(directory, 'mcp_server'))) return directory;
    const parent = resolve(directory, '..');
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

const repositoryRoot = findRepositoryRoot();

function loadProjectEnv(): void {
  const path = resolve(repositoryRoot, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
}

loadProjectEnv();

/** Non-secret Compass A2A defaults. Mirrored in `.env.example`; Token stays empty there. */
export const A2A_CONFIG_DEFAULTS = {
  baseUrl: 'https://dev-agent-fz.speiyou.com',
  clientId: 'xesapp-agent',
  waitSeconds: 180,
} as const;

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
  knowledgeQueryLog: z.string().default('.data/knowledge-queries.jsonl'),
  caseArchiveDir: z.string().default('.data/knowledge-cases'),
  projectRoot: z.string().default(repositoryRoot),
  knowledgeRoot: z.string().default('knowledge'),
  knowledgeRetrievalMode: z.string().optional(),
  knowledgePreviewStrategy: z.string().optional(),
  allowedRoots: z.array(z.string()).default([repositoryRoot]),
  corsOrigins: z.array(z.string()).default([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'https://localhost:5174',
    'https://127.0.0.1:5174',
  ]),
  mcpCommand: z.string().default('uv'),
  skillsDir: z.string().default(resolve(repositoryRoot, 'skills')),
  gitMirrorDir: z.string().default('.data/git-mirrors'),
  snapshotDir: z.string().default('.data/workspaces'),
  gitTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  maxConcurrentRuns: z.coerce.number().int().min(1).max(100).default(4),
  investigationMaxSeconds: z.coerce.number().int().min(10).max(3_600).default(300),
  investigationMaxRemoteCalls: z.coerce.number().int().min(0).max(10).default(2),
  runMode: z.enum(['local', 'server']).default('server'),
  publicBaseUrl: z.string().default(''),
  appPrefix: z.string().default('/xesapp-agent'),
  ssoBaseUrl: z.string().default(''),
  ssoAppId: z.string().default(''),
  ssoAppKey: z.string().default(''),
  a2aBaseUrl: z.string().default(A2A_CONFIG_DEFAULTS.baseUrl),
  a2aClientId: z.string().default(A2A_CONFIG_DEFAULTS.clientId),
  a2aToken: z.string().default(''),
  a2aWaitSeconds: z.coerce.number().int().min(1).max(3_600).default(A2A_CONFIG_DEFAULTS.waitSeconds),
  a2aMaxOutputChars: z.coerce.number().int().min(1_000).max(200_000).default(12_000),
  a2aDebugEnabled: booleanFromEnv,
  yachEnabled: booleanFromEnv,
  yachAppKey: z.string().default(''),
  yachAppSecret: z.string().default(''),
  yachBaseUrl: z.string().default('https://yach-oapi.zhiyinlou.com'),
  yachDispatchUrl: z.string().default('https://chatconf.msg.xescdn.com/v4/proxy/config'),
  yachChannelAppId: z.string().default('yach20001'),
  yachBizId: z.string().default('97'),
  yachVersionArea: z.string().default('YachAreaRed'),
  yachBridgePath: z.string().default(''),
  yachNodePath: z.string().default('node'),
  yachRobotId: z.string().default(''),
  logCatalogPath: z.string().default(''),
  logcenterAppId: z.string().default(''),
  logcenterAppSecret: z.string().default(''),
  logcenterBaseUrl: z.string().default('https://logcenter-api.tal.com/api'),
  logcenterTimeoutMs: z.coerce.number().int().min(100).max(120_000).default(15_000),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema> & {
  authMode: 'local' | 'sso';
};

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
    knowledgeQueryLog: env.HARMONY_AGENT_KNOWLEDGE_QUERY_LOG,
    caseArchiveDir: env.HARMONY_AGENT_KNOWLEDGE_CASES_DIR,
    projectRoot: env.HARMONY_MASTRA_PROJECT_ROOT,
    knowledgeRoot: env.HARMONY_AGENT_KNOWLEDGE_ROOT,
    knowledgeRetrievalMode: env.HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE,
    knowledgePreviewStrategy: env.HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY,
    allowedRoots: env.HARMONY_AGENT_ALLOWED_ROOTS?.split(',').map((value) => value.trim()).filter(Boolean),
    corsOrigins: env.HARMONY_AGENT_CORS_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean),
    mcpCommand: env.HARMONY_MASTRA_MCP_COMMAND,
    skillsDir: env.HARMONY_MASTRA_SKILLS_DIR,
    gitMirrorDir: env.HARMONY_MASTRA_GIT_MIRROR_DIR,
    snapshotDir: env.HARMONY_MASTRA_SNAPSHOT_DIR,
    gitTimeoutMs: env.HARMONY_MASTRA_GIT_TIMEOUT_MS,
    maxConcurrentRuns: env.HARMONY_AGENT_MAX_CONCURRENT_RUNS,
    investigationMaxSeconds: env.HARMONY_AGENT_INVESTIGATION_MAX_SECONDS,
    investigationMaxRemoteCalls: env.HARMONY_AGENT_INVESTIGATION_MAX_REMOTE_CALLS,
    runMode: env.HARMONY_AGENT_RUN_MODE || undefined,
    publicBaseUrl: env.HARMONY_AGENT_PUBLIC_BASE_URL,
    appPrefix: env.HARMONY_AGENT_APP_PREFIX,
    ssoBaseUrl: env.HARMONY_AGENT_SSO_BASE_URL,
    ssoAppId: env.HARMONY_AGENT_SSO_APP_ID,
    ssoAppKey: env.HARMONY_AGENT_SSO_APP_KEY,
    a2aBaseUrl: env.HARMONY_AGENT_A2A_BASE_URL,
    a2aClientId: env.HARMONY_AGENT_A2A_CLIENT_ID,
    a2aToken: env.HARMONY_AGENT_A2A_TOKEN,
    a2aWaitSeconds: env.HARMONY_AGENT_A2A_WAIT_SECONDS,
    a2aMaxOutputChars: env.HARMONY_AGENT_A2A_MAX_OUTPUT_CHARS,
    a2aDebugEnabled: env.HARMONY_AGENT_A2A_DEBUG_ENABLED,
    yachEnabled: env.HARMONY_AGENT_YACH_ENABLED,
    yachAppKey: env.HARMONY_AGENT_YACH_APP_KEY ?? env.YACH_APP_KEY,
    yachAppSecret: env.HARMONY_AGENT_YACH_APP_SECRET ?? env.YACH_APP_SECRET,
    yachBaseUrl: env.HARMONY_AGENT_YACH_BASE_URL ?? env.YACH_BASE_URL,
    yachDispatchUrl: env.HARMONY_AGENT_YACH_DISPATCH_URL,
    yachChannelAppId: env.HARMONY_AGENT_YACH_CHANNEL_APP_ID,
    yachBizId: env.HARMONY_AGENT_YACH_BIZ_ID,
    yachVersionArea: env.HARMONY_AGENT_YACH_VERSION_AREA,
    yachBridgePath: env.HARMONY_AGENT_YACH_BRIDGE_PATH,
    yachNodePath: env.HARMONY_AGENT_YACH_NODE_PATH,
    yachRobotId: env.HARMONY_AGENT_YACH_ROBOT_ID ?? env.YACH_ROBOT_ID,
    logCatalogPath: env.HARMONY_AGENT_LOG_CATALOG,
    logcenterAppId: env.HARMONY_AGENT_LOGCENTER_APP_ID,
    logcenterAppSecret: env.HARMONY_AGENT_LOGCENTER_APP_SECRET,
    logcenterBaseUrl: env.HARMONY_AGENT_LOGCENTER_BASE_URL,
    logcenterTimeoutMs: env.HARMONY_AGENT_LOGCENTER_TIMEOUT_MS,
  });
  const projectRoot = resolve(repositoryRoot, config.projectRoot);
  const fromRoot = (path: string) => resolve(projectRoot, path);
  const dataDir = fromRoot(config.dataDir);
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, '');
  const ssoBaseUrl = config.ssoBaseUrl.replace(/\/+$/, '');
  let appPrefix = (config.appPrefix || '/xesapp-agent').trim() || '/xesapp-agent';
  if (!appPrefix.startsWith('/')) appPrefix = `/${appPrefix}`;
  appPrefix = appPrefix.replace(/\/+$/, '') || '/xesapp-agent';
  const corsOrigins = [...config.corsOrigins];
  if (publicBaseUrl && !corsOrigins.includes(publicBaseUrl)) {
    corsOrigins.push(publicBaseUrl);
  }
  const a2aBaseUrl = config.a2aBaseUrl.replace(/\/+$/, '');
  const yachBridgePath = config.yachBridgePath.trim()
    ? (config.yachBridgePath.startsWith('/') ? config.yachBridgePath : fromRoot(config.yachBridgePath))
    : resolve(projectRoot, 'runtime/yach-bridge/bridge.cjs');
  const authMode = config.runMode === 'local' ? 'local' : 'sso';
  if (config.a2aDebugEnabled && config.runMode !== 'local') {
    throw new Error('A2A debug provider requires HARMONY_AGENT_RUN_MODE=local');
  }
  if (config.a2aDebugEnabled && !config.a2aToken.trim()) {
    throw new Error('A2A debug provider requires a non-empty local HARMONY_AGENT_A2A_TOKEN');
  }
  return {
    ...config,
    projectRoot,
    dataDir,
    webDist: fromRoot(config.webDist),
    legacyConversationsFile: fromRoot(config.legacyConversationsFile),
    legacyRepositoriesFile: fromRoot(config.legacyRepositoriesFile),
    legacySnapshotDir: fromRoot(config.legacySnapshotDir),
    modelConfigFile: fromRoot(config.modelConfigFile),
    knowledgeQueryLog: fromRoot(config.knowledgeQueryLog),
    caseArchiveDir: fromRoot(config.caseArchiveDir),
    knowledgeRoot: fromRoot(config.knowledgeRoot),
    allowedRoots: config.allowedRoots.map(fromRoot),
    skillsDir: fromRoot(config.skillsDir),
    gitMirrorDir: fromRoot(config.gitMirrorDir),
    snapshotDir: fromRoot(config.snapshotDir),
    databaseUrl: config.databaseUrl || `file:${resolve(dataDir, 'runtime.db')}`,
    host: config.runMode === 'local' ? '127.0.0.1' : config.host,
    authMode,
    publicBaseUrl,
    appPrefix,
    ssoBaseUrl,
    corsOrigins,
    a2aBaseUrl,
    a2aClientId: config.a2aClientId.trim() || A2A_CONFIG_DEFAULTS.clientId,
    a2aToken: config.a2aToken.trim(),
    a2aDebugEnabled: Boolean(config.a2aDebugEnabled),
    yachEnabled: Boolean(config.yachEnabled),
    yachAppKey: config.yachAppKey.trim(),
    yachAppSecret: config.yachAppSecret.trim(),
    yachBaseUrl: config.yachBaseUrl.replace(/\/+$/, ''),
    yachDispatchUrl: config.yachDispatchUrl.replace(/\/+$/, ''),
    yachChannelAppId: config.yachChannelAppId.trim() || 'yach20001',
    yachBizId: String(config.yachBizId || '97').trim() || '97',
    yachVersionArea: config.yachVersionArea.trim() || 'YachAreaRed',
    yachBridgePath,
    yachNodePath: config.yachNodePath.trim() || 'node',
    yachRobotId: config.yachRobotId.trim(),
    logCatalogPath: config.logCatalogPath.trim()
      ? (config.logCatalogPath.startsWith('/') ? config.logCatalogPath.trim() : fromRoot(config.logCatalogPath.trim()))
      : '',
    logcenterAppId: config.logcenterAppId.trim(),
    logcenterAppSecret: config.logcenterAppSecret.trim(),
    logcenterBaseUrl: (config.logcenterBaseUrl.trim() || 'https://logcenter-api.tal.com/api').replace(/\/+$/, ''),
  };
}

export function compassA2AClientConfig(config: Pick<RuntimeConfig, 'a2aBaseUrl' | 'a2aClientId' | 'a2aToken' | 'a2aWaitSeconds'>) {
  return {
    baseUrl: config.a2aBaseUrl,
    clientId: config.a2aClientId,
    token: config.a2aToken,
    waitSeconds: config.a2aWaitSeconds,
  };
}
