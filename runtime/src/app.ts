import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from './config.js';
import { compassA2AClientConfig } from './config.js';
import { createMastra } from './mastra.js';
import { createRuntimeDatabase } from './migration/legacy.js';
import { createConversationRoutes } from './http/conversations.js';
import { createAuthRoutes } from './http/auth.js';
import { ProductStore } from './product/store.js';
import { ModelConfiguration } from './model/configuration.js';
import { createModelRoutes } from './http/models.js';
import { RepositoryCapability } from './capabilities/repository.js';
import { CapabilityMcp } from './capabilities/mcp.js';
import { SkillRegistry } from './diagnosis/skills.js';
import { DiagnosisAgent } from './diagnosis/agent.js';
import {
  CODE_INDEX_MCP_TOOL_NAMES,
  MODEL_CONTEXT_WINDOWS,
  MODEL_PRICES,
  REPOSITORY_MCP_TOOL_NAMES,
} from './model/metadata.js';
import { redactSensitiveText } from './security/redaction.js';
import {
  LocalIdentityProvider,
  SSOIdentityProvider,
  requireIdentity,
  type AuthVariables,
  type IdentityProvider,
} from './auth/index.js';
import { isYachImConfigured, YachChannel } from './channels/yach/index.js';
import { InMemoryRunAdmission, type RunAdmission } from './orchestration/admission.js';
import { InMemoryAgentSlotRegistry } from './orchestration/agent-slot-registry.js';
import {
  COMPASS_A2A_AGENT_CARD_PATH,
  CompassA2AClient,
  isCompassA2AConfigured,
} from './capabilities/compass-a2a.js';
import { CompassSlotAdapter } from './capabilities/compass-slot.js';
import { createCompassA2ADebugRoutes } from './capabilities/compass-a2a-debug.js';
import { loadServerSignals } from './orchestration/server-signals.js';
import { VersionRegistry } from './capabilities/version-registry.js';
import { GitLabArchiveClient, GitLabArchiveError } from './capabilities/gitlab-archive.js';
import { ArchiveSnapshotError } from './capabilities/archive-snapshot.js';
import {
  materializeMultiRepositorySnapshot,
  MultiRepositorySnapshotError,
} from './capabilities/multi-repository-snapshot.js';
import { RepositoryGitError } from './capabilities/repository.js';
import { VersionRegistryError } from './capabilities/version-registry.js';

export interface RuntimeApp {
  app: Hono<{ Variables: AuthVariables }>;
  mastra: ReturnType<typeof createMastra>;
  store: ProductStore;
  modelConfiguration: ModelConfiguration;
  repositories: RepositoryCapability;
  versionRegistry: VersionRegistry;
  capabilities: CapabilityMcp;
  skills: SkillRegistry;
  diagnosisAgent: DiagnosisAgent;
  admission: RunAdmission;
  slotRegistry: InMemoryAgentSlotRegistry;
  identityProvider: IdentityProvider;
  yachChannel: YachChannel | null;
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
    // Repository metadata is reconstructed from the version registry per process;
    // legacy user-registered rows must not become a source-selection input.
    const repositories = new RepositoryCapability({ snapshotDir: config.snapshotDir });
    const versionRegistry = new VersionRegistry(config.versionRegistryRoot);
    await versionRegistry.load();
    const gitlabArchiveClient = config.gitlabToken
      ? new GitLabArchiveClient({
        baseUrl: config.gitlabBaseUrl,
        token: config.gitlabToken,
        timeoutMs: config.gitlabTimeoutMs,
      })
      : null;
    const capabilities = new CapabilityMcp(config);
    const skills = new SkillRegistry(config.skillsDir);
    await skills.load();
    const diagnosisAgent = new DiagnosisAgent(modelConfiguration, skills, mastra);
    const admission = new InMemoryRunAdmission(config.maxConcurrentRuns);
    const serverSignals = await loadServerSignals(resolve(config.projectRoot, 'runtime/contracts/server-signals.yaml'));
    const slotRegistry = new InMemoryAgentSlotRegistry();
    if (isCompassA2AConfigured(config.a2aToken)) {
      const compass = new CompassA2AClient(compassA2AClientConfig(config));
      slotRegistry.register({
        slot: {
          slotId: 'compass',
          agentCardUrl: new URL(COMPASS_A2A_AGENT_CARD_PATH, `${config.a2aBaseUrl}/`).toString(),
          role: 'external',
          capabilities: ['frontend-investigation', 'h5-investigation', 'server-investigation'],
          authRef: 'runtime:a2aToken',
          timeoutMs: config.a2aWaitSeconds * 1000,
          maxOutputChars: config.a2aMaxOutputChars,
          evidenceMode: 'external_findings',
        },
        adapter: new CompassSlotAdapter(compass),
      });
    }
    const identityProvider: IdentityProvider =
      config.authMode === 'local'
        ? new LocalIdentityProvider({ publicBaseUrl: config.publicBaseUrl })
        : new SSOIdentityProvider({
            publicBaseUrl: config.publicBaseUrl,
            appPrefix: config.appPrefix,
            ssoBaseUrl: config.ssoBaseUrl,
            ssoAppId: config.ssoAppId,
            ssoAppKey: config.ssoAppKey,
          });

    const createConversationSource = async ({
      platform,
      productLine,
      formFactor,
      version,
      build,
      signal,
    }: {
      platform: 'harmony' | 'android' | 'ios';
      productLine: 'xueersi' | 'xuejiayun' | null;
      formFactor: 'phone' | 'pad' | 'universal' | null;
      version: string | null;
      build: string | null;
      signal?: AbortSignal;
    }) => {
      try {
        let selection;
        let nearestVersion: string | null = null;
        try {
          selection = versionRegistry.select({
            platform,
            productLine: productLine ?? undefined,
            formFactor: formFactor ?? undefined,
            version,
            build,
          });
        } catch (error) {
          if (!(error instanceof VersionRegistryError)
            || !version
            || !['version_not_registered', 'build_not_registered'].includes(error.code)) throw error;
          selection = versionRegistry.select({
            platform,
            productLine: productLine ?? undefined,
            formFactor: formFactor ?? undefined,
          });
          nearestVersion = selection.entry.version;
        }
        const snapshots = await Promise.all(selection.repositories.map(async (registryRepository) => {
          const repository = await repositories.ensureRegistryRepository(
            registryRepository.repository_id,
            { baseUrl: config.gitlabBaseUrl, ref: registryRepository.ref },
          );
          const snapshot = gitlabArchiveClient
            ? await gitlabArchiveClient.downloadArchive(registryRepository.repository_id, registryRepository.expected_commit, signal)
              .then(({ archive }) => repositories.prepareArchiveSnapshot(
                repository.id,
                registryRepository.ref,
                registryRepository.expected_commit,
                archive,
              ))
            : await repositories.getPreparedSnapshot(
              repository.id,
              registryRepository.ref,
              registryRepository.expected_commit,
            );
          await store.saveSnapshot(snapshot);
          return { registryRepository, repository, snapshot };
        }));
        const shell = snapshots.find((item) => item.registryRepository.role === 'shell');
        if (!shell) throw new RepositoryGitError('当前版本没有 shell 仓库');
        const sourceRepositories = snapshots.map(({ registryRepository, repository, snapshot }) => ({
          repository_id: repository.id,
          repository_name: repository.name,
          requested_ref: snapshot.requested_ref,
          resolved_commit: snapshot.resolved_commit,
          role: registryRepository.role,
          mount_path: registryRepository.mount_path ?? '',
        }));
        const workspacePath = snapshots.length === 1
          ? shell.snapshot.workspace_path
          : (await materializeMultiRepositorySnapshot({
            snapshotRoot: config.snapshotDir,
            repositories: snapshots.map(({ registryRepository, snapshot }) => ({
              snapshot,
              role: registryRepository.role,
              mountPath: registryRepository.mount_path ?? '',
            })),
          })).workspace_path;
        const sourceCompleteness = snapshots.some((item) => item.registryRepository.role !== 'shell')
          ? 'complete' as const
          : 'partial' as const;
        return {
          workspace_path: workspacePath,
          repository_id: shell.repository.id,
          repository_name: shell.repository.name,
          requested_ref: shell.snapshot.requested_ref,
          resolved_commit: shell.snapshot.resolved_commit,
          source_repositories: sourceRepositories,
          source_completeness: sourceCompleteness,
          source_limitations: [
            ...(sourceCompleteness === 'partial' ? ['当前登记只包含 shell 仓库，组件源码未挂载。'] : []),
            ...(nearestVersion && version && nearestVersion !== version
              ? [`现场日志版本 ${version} 未登记，当前绑定 ${nearestVersion} 作为近邻源码对照；不能据此确认现场版本行为。`]
              : []),
          ],
          platform,
          product_line: selection.entry.product_line,
          form_factor: formFactor,
          version: selection.entry.version,
          build: selection.build.build ?? null,
        };
      } catch (error) {
        if (error instanceof VersionRegistryError || error instanceof GitLabArchiveError || error instanceof ArchiveSnapshotError || error instanceof MultiRepositorySnapshotError) {
          throw new RepositoryGitError(error.message, { cause: error });
        }
        throw error;
      }
    };

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
    app.route('/', createAuthRoutes(identityProvider, config.authMode));
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
      mcp_tools: [
        ...REPOSITORY_MCP_TOOL_NAMES,
        ...(config.codeIndexCommand ? CODE_INDEX_MCP_TOOL_NAMES : []),
      ],
      constraints: ['read-only', 'no-shell', 'no-code-changes', 'no-deveco-cli'],
      context_windows: MODEL_CONTEXT_WINDOWS,
      model_prices: MODEL_PRICES,
    }));
    app.route('/api', createConversationRoutes(store, diagnosisAgent, capabilities, modelConfiguration, {
      knowledgeQueryLog: config.knowledgeQueryLog,
      caseArchiveDir: config.caseArchiveDir,
      admission,
      serverSignals,
      slotRegistry,
      compassAvailable: isCompassA2AConfigured(config.a2aToken),
      investigationBudget: {
        maxSeconds: config.investigationMaxSeconds,
        maxRemoteCalls: config.investigationMaxRemoteCalls,
      },
      createConversationSource,
    }));
    app.route('/api', createModelRoutes(modelConfiguration));

    if (config.serveWeb) {
      const webRoot = resolve(config.projectRoot, config.webDist);
      const appPrefix = config.appPrefix;
      // Vite emits absolute URLs like /xesapp-agent/assets/*.js. serveStatic joins
      // root + req.path, so strip the app prefix or it looks under web/dist/xesapp-agent/.
      app.use(
        '/assets/*',
        serveStatic({
          root: webRoot,
          rewriteRequestPath: (path) =>
            path.startsWith(appPrefix) ? path.slice(appPrefix.length) || '/' : path,
        }),
      );
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

    if (config.a2aDebugEnabled) {
      root.route('/', createCompassA2ADebugRoutes({
        token: config.a2aToken,
        modelConfiguration,
      }));
    }
    root.route('/', app);
    const yachChannel = isYachImConfigured(config)
      ? new YachChannel({
        config,
        store,
        diagnosisAgent,
        capabilities,
        modelConfiguration,
        // 与网页共用编排：否则 IM 只走 legacy，模型写了 next_action=external 也不会真调 Compass。
        diagnosisOptions: {
          knowledgeQueryLog: config.knowledgeQueryLog,
          caseArchiveDir: config.caseArchiveDir,
          serverSignals,
          slotRegistry,
          compassAvailable: isCompassA2AConfigured(config.a2aToken),
          investigationBudget: {
            maxSeconds: config.investigationMaxSeconds,
            maxRemoteCalls: config.investigationMaxRemoteCalls,
          },
          createConversationSource,
        },
      })
      : null;
    return {
      app: root,
      mastra,
      store,
      modelConfiguration,
      repositories,
      versionRegistry,
      capabilities,
      skills,
      diagnosisAgent,
      admission,
      slotRegistry,
      identityProvider,
      yachChannel,
    };
  } catch (error) {
    await Promise.allSettled([
      ...(storeForCleanup ? [Promise.resolve().then(() => storeForCleanup!.close())] : []),
      Promise.resolve().then(() => mastra.getStorage()?.close()),
    ]);
    throw error;
  }
}
