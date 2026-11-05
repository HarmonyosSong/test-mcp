import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from './config.js';
import { createMastra } from './mastra.js';
import { createRuntimeDatabase } from './migration/legacy.js';
import { createConversationRoutes } from './http/conversations.js';
import { createAuthRoutes } from './http/auth.js';
import { ProductStore } from './product/store.js';
import { ModelConfiguration } from './model/configuration.js';
import { createModelRoutes } from './http/models.js';
import { createRepositoryRoutes } from './http/repositories.js';
import { RepositoryCapability } from './capabilities/repository.js';
import { CapabilityMcp } from './capabilities/mcp.js';
import { SkillRegistry } from './diagnosis/skills.js';
import { DiagnosisAgent } from './diagnosis/agent.js';
import { MODEL_CONTEXT_WINDOWS, MODEL_PRICES, REPOSITORY_MCP_TOOL_NAMES } from './model/metadata.js';
import { redactSensitiveText } from './security/redaction.js';
import {
  SSOIdentityProvider,
  requireIdentity,
  type AuthVariables,
} from './auth/index.js';

export interface RuntimeApp {
  app: Hono<{ Variables: AuthVariables }>;
  mastra: ReturnType<typeof createMastra>;
  store: ProductStore;
  modelConfiguration: ModelConfiguration;
  repositories: RepositoryCapability;
  capabilities: CapabilityMcp;
  skills: SkillRegistry;
  diagnosisAgent: DiagnosisAgent;
  identityProvider: SSOIdentityProvider;
}

export async function createRuntimeApp(config: RuntimeConfig): Promise<RuntimeApp> {
  const mastra = createMastra(config);
  let storeForCleanup: ProductStore | undefined;
  try {
    const database = createRuntimeDatabase(config);
    const store = new ProductStore(database);
    storeForCleanup = store;
    await store.initialize();
    if (config.databaseUrl.startsWith('file:')) {
      await chmod(fileURLToPath(new URL(config.databaseUrl)), 0o600);
    }
    const modelConfiguration = new ModelConfiguration({ filePath: config.modelConfigFile });
    await modelConfiguration.initialize();
    const repositories = new RepositoryCapability({
      mirrorDir: config.gitMirrorDir,
      snapshotDir: config.snapshotDir,
      allowedRoots: config.allowedRoots,
      timeoutMs: config.gitTimeoutMs,
      initialRecords: await store.listRepositories(),
    });
    const capabilities = new CapabilityMcp(config);
    const skills = new SkillRegistry(config.skillsDir);
    await skills.load();
    const diagnosisAgent = new DiagnosisAgent(modelConfiguration, skills, mastra);
    const identityProvider = new SSOIdentityProvider({
      publicBaseUrl: config.publicBaseUrl,
      appPrefix: config.appPrefix,
      ssoBaseUrl: config.ssoBaseUrl,
      ssoAppId: config.ssoAppId,
      ssoAppKey: config.ssoAppKey,
    });

    const root = new Hono<{ Variables: AuthVariables }>();
    root.onError((error, context) => {
      console.error(modelConfiguration.redact(redactSensitiveText(error.message)));
      return context.json({ detail: 'Internal Server Error' }, 500);
    });
    root.notFound((context) => context.json({ detail: 'Not Found' }, 404));
    root.use('*', cors({
      origin: config.corsOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['*', 'X-CSRF-Token', 'Content-Type', 'Accept'],
      credentials: true,
    }));

    const app = new Hono<{ Variables: AuthVariables }>().basePath(config.appPrefix);
    app.route('/', createAuthRoutes(identityProvider));
    app.get('/api/health', (context) =>
      context.json({
        status: 'ok',
        mode: modelConfiguration.enabled ? 'model' : 'demo',
        model: modelConfiguration.status().model_name,
        provider: modelConfiguration.status().provider_name,
      }),
    );
    app.use('/api/*', requireIdentity(identityProvider));
    app.get('/api/meta', async (context) => context.json({
      mode: modelConfiguration.enabled ? 'model' : 'demo',
      model: modelConfiguration.status().model_name,
      skills: skills.summaries(),
      mcp_tools: REPOSITORY_MCP_TOOL_NAMES,
      constraints: ['read-only', 'no-shell', 'no-code-changes', 'no-deveco-cli'],
      context_windows: MODEL_CONTEXT_WINDOWS,
      model_prices: MODEL_PRICES,
    }));
    app.route('/api', createConversationRoutes(store, diagnosisAgent, capabilities, modelConfiguration, {
      knowledgeQueryLog: config.knowledgeQueryLog,
      caseArchiveDir: config.caseArchiveDir,
      createConversationSource: async ({ repositoryId, branch, workspacePath }) => {
        if (repositoryId && branch) {
          const snapshot = await repositories.prepareSnapshot(repositoryId, branch);
          await store.saveSnapshot(snapshot);
          return snapshot;
        }
        if (workspacePath) return { workspace_path: await repositories.validateWorkspacePath(workspacePath) };
        return {};
      },
    }));
    app.route('/api', createModelRoutes(modelConfiguration));
    app.route('/api', createRepositoryRoutes(repositories, store));

    if (config.serveWeb) {
      const webRoot = resolve(config.projectRoot, config.webDist);
      app.use('/assets/*', serveStatic({ root: webRoot }));
      app.get('*', async (context) => {
        const path = context.req.path;
        if (path.includes('/api/') || path.includes('/auth/')) return context.notFound();
        try {
          return new Response(await readFile(resolve(webRoot, 'index.html')), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        } catch {
          return context.text('Web build not found. Run npm --prefix web run build.', 503);
        }
      });
    }

    root.route('/', app);
    return {
      app: root,
      mastra,
      store,
      modelConfiguration,
      repositories,
      capabilities,
      skills,
      diagnosisAgent,
      identityProvider,
    };
  } catch (error) {
    await Promise.allSettled([
      ...(storeForCleanup ? [Promise.resolve().then(() => storeForCleanup!.close())] : []),
      Promise.resolve().then(() => mastra.getStorage()?.close()),
    ]);
    throw error;
  }
}
