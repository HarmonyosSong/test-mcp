import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';
import { UCENTER_DEFAULT_BASE_URL } from './capabilities/ucenter.js';

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === 'true');

/** Unset/empty defaults to true; only explicit false/0 disables. */
const booleanFromEnvDefaultTrue = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value.trim() === '') return true;
    const normalized = value.trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0' && normalized !== 'off' && normalized !== 'no';
  });

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
  waitSeconds: 600,
} as const;

export const runtimeConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8000),
  dataRoot: z.string().optional(),
  dataDir: z.string().optional(),
  databaseUrl: z.string().default(''),
  webDist: z.string().default('web/dist'),
  serveWeb: booleanFromEnv,
  legacyConversationsFile: z.string().optional(),
  legacyRepositoriesFile: z.string().optional(),
  legacySnapshotDir: z.string().optional(),
  modelConfigFile: z.string().optional(),
  knowledgeQueryLog: z.string().optional(),
  caseArchiveDir: z.string().optional(),
  mastraObservabilityDir: z.string().optional(),
  projectRoot: z.string().default(repositoryRoot),
  knowledgeRoot: z.string().default('knowledge'),
  knowledgeRetrievalMode: z.string().optional(),
  knowledgePreviewStrategy: z.string().optional(),
  corsOrigins: z.array(z.string()).default([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'https://localhost:5174',
    'https://127.0.0.1:5174',
  ]),
  mcpCommand: z.string().default('uv'),
  codeIndexCommand: z.string().trim().default(''),
  codeIndexCacheDir: z.string().default('.data/codebase-memory'),
  codeIndexFile: z.string().default('code-index/index.jsonl'),
  codeIndexScopeFile: z.string().default('code-index/version-scope.json'),
  codeIndexMode: z.enum(['fast']).default('fast'),
  codeIndexTimeoutSeconds: z.coerce.number().int().min(5).max(600).default(90),
  skillsDir: z.string().default(resolve(repositoryRoot, 'skills')),
  snapshotDir: z.string().optional(),
  versionRegistryRoot: z.string().default('version-registry'),
  gitlabBaseUrl: z.string().default('https://git.100tal.com'),
  gitlabToken: z.string().default(''),
  gitlabTimeoutMs: z.coerce.number().int().min(100).max(600_000).default(30_000),
  maxConcurrentRuns: z.coerce.number().int().min(1).max(100).default(4),
  investigationMaxSeconds: z.coerce.number().int().min(10).max(3_600).default(900),
  investigationMaxRemoteCalls: z.coerce.number().int().min(0).max(10).default(4),
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
  mastraObservabilityConsole: booleanFromEnvDefaultTrue,
  /** 0 = keep full observability text; positive = max chars per text field. */
  mastraObservabilityPreviewChars: z.coerce.number().int().min(0).max(2_000_000).default(0),
  yachEnabled: booleanFromEnv,
  yachAppKey: z.string().default(''),
  yachAppSecret: z.string().default(''),
  yachCliPath: z.string().default('yach-cli'),
  yachRobotId: z.string().default(''),
  /** 学员编号通过内网 UCenter 查档案（lookup_learner）。 */
  ucenterBaseUrl: z.string().default(UCENTER_DEFAULT_BASE_URL),
  ucenterTimeoutMs: z.coerce.number().int().min(100).max(60_000).default(10_000),
  /** 独立 log-mcp HTTP 入口；空字符串表示本轮不尝试挂载。 */
  logMcpUrl: z.string().default('http://127.0.0.1:8766/mcp'),
  logMcpBearerToken: z.string().default(''),
  logMcpTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
});

export type RuntimeConfig = Omit<
  z.infer<typeof runtimeConfigSchema>,
  | 'dataRoot'
  | 'dataDir'
  | 'legacyConversationsFile'
  | 'legacyRepositoriesFile'
  | 'legacySnapshotDir'
  | 'modelConfigFile'
  | 'knowledgeQueryLog'
  | 'caseArchiveDir'
  | 'mastraObservabilityDir'
  | 'snapshotDir'
> & {
  authMode: 'local' | 'sso';
  dataDir: string;
  legacyConversationsFile: string;
  legacyRepositoriesFile: string;
  legacySnapshotDir: string;
  modelConfigFile: string;
  knowledgeQueryLog: string;
  caseArchiveDir: string;
  mastraObservabilityDir: string;
  snapshotDir: string;
};

function optionalEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const config = runtimeConfigSchema.parse({
    host: env.HARMONY_MASTRA_HOST,
    port: env.HARMONY_MASTRA_PORT,
    dataRoot: optionalEnvPath(env.HARMONY_AGENT_DATA_ROOT),
    dataDir: optionalEnvPath(env.HARMONY_MASTRA_DATA_DIR),
    databaseUrl: env.HARMONY_MASTRA_DATABASE_URL,
    webDist: env.HARMONY_MASTRA_WEB_DIST,
    serveWeb: env.HARMONY_MASTRA_SERVE_WEB,
    legacyConversationsFile: optionalEnvPath(env.HARMONY_MASTRA_LEGACY_CONVERSATIONS_FILE),
    legacyRepositoriesFile: optionalEnvPath(env.HARMONY_MASTRA_LEGACY_REPOSITORIES_FILE),
    legacySnapshotDir: optionalEnvPath(env.HARMONY_MASTRA_LEGACY_SNAPSHOT_DIR),
    modelConfigFile: optionalEnvPath(env.HARMONY_AGENT_MODEL_CONFIG_FILE),
    knowledgeQueryLog: optionalEnvPath(env.HARMONY_AGENT_KNOWLEDGE_QUERY_LOG),
    caseArchiveDir: optionalEnvPath(env.HARMONY_AGENT_KNOWLEDGE_CASES_DIR),
    mastraObservabilityDir: optionalEnvPath(env.HARMONY_AGENT_MASTRA_OBSERVABILITY_DIR),
    projectRoot: env.HARMONY_MASTRA_PROJECT_ROOT,
    knowledgeRoot: env.HARMONY_AGENT_KNOWLEDGE_ROOT,
    knowledgeRetrievalMode: env.HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE,
    knowledgePreviewStrategy: env.HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY,
    corsOrigins: env.HARMONY_AGENT_CORS_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean),
    mcpCommand: env.HARMONY_MASTRA_MCP_COMMAND,
    codeIndexCommand: env.HARMONY_AGENT_CODE_INDEX_COMMAND,
    codeIndexCacheDir: env.HARMONY_AGENT_CODE_INDEX_CACHE,
    codeIndexFile: env.HARMONY_AGENT_CODE_INDEX_FILE,
    codeIndexScopeFile: env.HARMONY_AGENT_CODE_INDEX_SCOPE_FILE,
    codeIndexMode: env.HARMONY_AGENT_CODE_INDEX_MODE,
    codeIndexTimeoutSeconds: env.HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS,
    skillsDir: env.HARMONY_MASTRA_SKILLS_DIR,
    snapshotDir: optionalEnvPath(env.HARMONY_MASTRA_SNAPSHOT_DIR),
    versionRegistryRoot: env.HARMONY_AGENT_VERSION_REGISTRY_ROOT,
    gitlabBaseUrl: env.HARMONY_AGENT_GITLAB_BASE_URL,
    gitlabToken: env.HARMONY_AGENT_GITLAB_TOKEN ?? env.ANALYSIS_GIT_TOKEN,
    gitlabTimeoutMs: env.HARMONY_AGENT_GITLAB_TIMEOUT_MS,
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
    mastraObservabilityConsole: env.HARMONY_AGENT_MASTRA_OBSERVABILITY_CONSOLE,
    mastraObservabilityPreviewChars: env.HARMONY_AGENT_MASTRA_OBSERVABILITY_PREVIEW_CHARS,
    yachEnabled: env.HARMONY_AGENT_YACH_ENABLED,
    yachAppKey: env.HARMONY_AGENT_YACH_APP_KEY ?? env.YACH_APP_KEY,
    yachAppSecret: env.HARMONY_AGENT_YACH_APP_SECRET ?? env.YACH_APP_SECRET,
    yachCliPath: env.HARMONY_AGENT_YACH_CLI_PATH,
    yachRobotId: env.HARMONY_AGENT_YACH_ROBOT_ID ?? env.YACH_ROBOT_ID,
    ucenterBaseUrl: env.HARMONY_AGENT_UCENTER_BASE_URL,
    ucenterTimeoutMs: env.HARMONY_AGENT_UCENTER_TIMEOUT_MS,
    logMcpUrl: env.LOG_MCP_URL || defaultLogMcpUrl(env),
    logMcpBearerToken: env.LOG_MCP_BEARER_TOKEN,
    logMcpTimeoutMs: env.LOG_MCP_CLIENT_TIMEOUT_MS,
  });
  const projectRoot = resolve(repositoryRoot, config.projectRoot);
  const fromRoot = (path: string) => resolve(projectRoot, path);
  const dataRoot = fromRoot(config.dataRoot || '.data');
  const underDataRoot = (override: string | undefined, segment: string) =>
    override ? fromRoot(override) : resolve(dataRoot, segment);
  const dataDir = underDataRoot(config.dataDir, 'mastra');
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
    legacyConversationsFile: underDataRoot(config.legacyConversationsFile, 'conversations.json'),
    legacyRepositoriesFile: underDataRoot(config.legacyRepositoriesFile, 'repositories.json'),
    legacySnapshotDir: underDataRoot(config.legacySnapshotDir, 'workspaces'),
    modelConfigFile: underDataRoot(config.modelConfigFile, 'model-config.json'),
    knowledgeQueryLog: underDataRoot(config.knowledgeQueryLog, 'knowledge-queries.jsonl'),
    caseArchiveDir: underDataRoot(config.caseArchiveDir, 'knowledge-cases'),
    mastraObservabilityDir: config.mastraObservabilityDir
      ? fromRoot(config.mastraObservabilityDir)
      : resolve(dataDir, 'observability'),
    knowledgeRoot: fromRoot(config.knowledgeRoot),
    skillsDir: fromRoot(config.skillsDir),
    codeIndexCacheDir: config.codeIndexCacheDir === '.data/codebase-memory'
      ? resolve(dataRoot, 'codebase-memory')
      : fromRoot(config.codeIndexCacheDir),
    codeIndexFile: fromRoot(config.codeIndexFile),
    codeIndexScopeFile: fromRoot(config.codeIndexScopeFile),
    snapshotDir: underDataRoot(config.snapshotDir, 'workspaces'),
    versionRegistryRoot: fromRoot(config.versionRegistryRoot),
    gitlabBaseUrl: (config.gitlabBaseUrl.trim() || 'https://git.100tal.com').replace(/\/+$/, ''),
    gitlabToken: config.gitlabToken.trim(),
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
    mastraObservabilityConsole: Boolean(config.mastraObservabilityConsole),
    yachEnabled: Boolean(config.yachEnabled),
    yachAppKey: config.yachAppKey.trim(),
    yachAppSecret: config.yachAppSecret.trim(),
    yachCliPath: config.yachCliPath.trim() || 'yach-cli',
    yachRobotId: config.yachRobotId.trim(),
    ucenterBaseUrl: (config.ucenterBaseUrl.trim() || UCENTER_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    ucenterTimeoutMs: config.ucenterTimeoutMs,
    logMcpUrl: normalizeLogMcpUrl(config.logMcpUrl),
    logMcpBearerToken: config.logMcpBearerToken.trim(),
  };
}

function defaultLogMcpUrl(env: NodeJS.ProcessEnv): string {
  const host = (env.LOG_MCP_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = (env.LOG_MCP_PORT || '8766').trim() || '8766';
  return `http://${host}:${port}/mcp`;
}

function normalizeLogMcpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function compassA2AClientConfig(config: Pick<RuntimeConfig, 'a2aBaseUrl' | 'a2aClientId' | 'a2aToken' | 'a2aWaitSeconds'>) {
  return {
    baseUrl: config.a2aBaseUrl,
    clientId: config.a2aClientId,
    token: config.a2aToken,
    waitSeconds: config.a2aWaitSeconds,
  };
}
