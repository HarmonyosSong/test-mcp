import { Hono } from 'hono';
import { MastraServer } from '@mastra/hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeConfig } from './config.js';
import { createMastra } from './mastra.js';
import { createRuntimeDatabase } from './migration/legacy.js';
import { createConversationRoutes, createRenameConversationRoute } from './http/conversations.js';
import { ProductStore } from './product/store.js';
import { ModelConfiguration } from './model/configuration.js';
import { createModelRoutes } from './http/models.js';
import { createRepositoryRoutes } from './http/repositories.js';
import { RepositoryCapability } from './capabilities/repository.js';
import { CapabilityMcp } from './capabilities/mcp.js';
import { SkillRegistry } from './diagnosis/skills.js';
import { DiagnosisAgent } from './diagnosis/agent.js';

export interface RuntimeApp {
  app: Hono;
  mastra: ReturnType<typeof createMastra>;
  adapter: MastraServer;
  store: ProductStore;
  modelConfiguration: ModelConfiguration;
  repositories: RepositoryCapability;
  capabilities: CapabilityMcp;
  skills: SkillRegistry;
  diagnosisAgent: DiagnosisAgent;
}

export async function createRuntimeApp(config: RuntimeConfig): Promise<RuntimeApp> {
  const mastra = createMastra(config);
  const database = createRuntimeDatabase(config);
  const store = new ProductStore(database);
  await store.initialize();
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
  const diagnosisAgent = new DiagnosisAgent(modelConfiguration, skills);
  const app = new Hono();
  const adapter = new MastraServer({ app, mastra });
  await adapter.init();

  app.get('/api/health', (context) =>
    context.json({ status: 'ok', mode: modelConfiguration.enabled ? 'model' : 'demo', model: modelConfiguration.status().model_name, provider: modelConfiguration.status().provider }),
  );

  app.get('/api/meta', async (context) => context.json({
    mode: modelConfiguration.enabled ? 'model' : 'demo',
    model: modelConfiguration.status().model_name,
    skills: skills.summaries(),
    mcp_tools: await capabilities.knowledgeToolNames().catch(() => []),
    constraints: ['诊断只读', '正向根因必须引用证据账本中的观测'],
    context_windows: {},
    model_prices: {},
  }));

  app.route('/api', createConversationRoutes(store, diagnosisAgent, capabilities, modelConfiguration, {
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
  app.route('/api', createRenameConversationRoute(store));
  app.route('/api', createModelRoutes(modelConfiguration));
  app.route('/api', createRepositoryRoutes(repositories, store));

  if (config.serveWeb) {
    const webRoot = resolve(config.projectRoot, config.webDist);
    app.use('/assets/*', serveStatic({ root: webRoot }));
    app.get('*', async (context) => {
      if (context.req.path.startsWith('/api/')) return context.notFound();
      try {
        return new Response(await readFile(resolve(webRoot, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      } catch {
        return context.text('Web build not found. Run npm --prefix web run build.', 503);
      }
    });
  }

  return { app, mastra, adapter, store, modelConfiguration, repositories, capabilities, skills, diagnosisAgent };
}
