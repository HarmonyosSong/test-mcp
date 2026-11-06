import { resolve } from 'node:path';

import { MCPClient } from '@mastra/mcp';
import { noopLogger } from '@mastra/core/logger';
import type { RuntimeConfig } from '../config.js';
import { createExternalKnowledgeTools, createExternalKnowledgeToolsForConfig, decodeExternalMcpResult, loadExternalKnowledgeConfig, type ExternalToolCall } from './external-knowledge.js';
import { createLogCatalogTools } from './log-center.js';

type ExternalKnowledgeTools = NonNullable<Awaited<ReturnType<typeof createExternalKnowledgeTools>>>['tools'];
type LogCatalogTools = NonNullable<Awaited<ReturnType<typeof createLogCatalogTools>>>;

export function knowledgeServerEnvironment(config: RuntimeConfig, conversationId: string, messageId: string): Record<string, string> {
  return {
    HARMONY_AGENT_KNOWLEDGE_ROOT: resolve(config.projectRoot, config.knowledgeRoot),
    HARMONY_AGENT_KNOWLEDGE_QUERY_LOG: resolve(config.projectRoot, config.knowledgeQueryLog),
    HARMONY_AGENT_QUERY_CONVERSATION_ID: conversationId,
    HARMONY_AGENT_QUERY_MESSAGE_ID: messageId,
    ...(config.knowledgeRetrievalMode ? { HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE: config.knowledgeRetrievalMode } : {}),
    ...(config.knowledgePreviewStrategy ? { HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY: config.knowledgePreviewStrategy } : {}),
  };
}

export type MastraToolsets = Awaited<ReturnType<MCPClient['listToolsets']>>;

export class CapabilityMcp {
  constructor(private readonly config: RuntimeConfig) {}

  async createKnowledgeSession(conversationId: string, messageId: string): Promise<{
    client: MCPClient;
    toolsets: MastraToolsets;
  } | null> {
    const client = new MCPClient({
      id: `troubleshoot-knowledge-${conversationId}-${messageId}`,
      timeout: 30_000,
      registerProcessHooks: false,
      servers: {
        knowledge: {
          command: this.config.mcpCommand,
          args: ['run', '--project', resolve(this.config.projectRoot, 'mcp_server'), 'harmony-knowledge-mcp'],
          cwd: resolve(this.config.projectRoot),
          stderr: 'pipe',
          logger: () => undefined,
          env: knowledgeServerEnvironment(this.config, conversationId, messageId),
          timeout: 30_000,
        },
      },
    });
    client.__setLogger(noopLogger);
    try {
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: 15_000 });
      if (discovered.errors.knowledge) throw new Error(`knowledge MCP unavailable: ${discovered.errors.knowledge}`);
      return { client, toolsets: discovered.toolsets };
    } catch {
      await client.disconnect();
      return null;
    }
  }

  async createRepositorySession(conversationId: string, snapshotPath: string): Promise<{
    client: MCPClient;
    toolsets: MastraToolsets;
  }> {
    const client = new MCPClient({
      id: `troubleshoot-repository-${conversationId}-${Date.now()}`,
      timeout: 30_000,
      registerProcessHooks: false,
      servers: {
        repository: {
          command: this.config.mcpCommand,
          args: ['run', '--project', resolve(this.config.projectRoot, 'mcp_server'), 'harmony-repository-mcp'],
          cwd: resolve(this.config.projectRoot),
          stderr: 'pipe',
          logger: () => undefined,
          env: { HARMONY_AGENT_MCP_WORKSPACE: resolve(snapshotPath) },
          timeout: 30_000,
        },
      },
    });
    client.__setLogger(noopLogger);
    try {
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: 15_000 });
      if (discovered.errors.repository) {
        throw new Error(`repository MCP unavailable: ${discovered.errors.repository}`);
      }
      return { client, toolsets: discovered.toolsets };
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  }

  async createExternalKnowledgeTools(inputTexts: string[], projectRoot = this.config.projectRoot): Promise<{ tools: ExternalKnowledgeTools; client?: MCPClient } | null> {
    const path = this.config.externalKnowledgeConfigFile;
    if (!path) return null;
    let externalConfig;
    try {
      externalConfig = await loadExternalKnowledgeConfig(path);
    } catch {
      const fallback = await createExternalKnowledgeTools(path, inputTexts, projectRoot, async () => { throw new Error('external_configuration_error: check the configured JSON file'); });
      return fallback ? { tools: fallback.tools } : null;
    }
    const serverName = 'external_knowledge';
    let client: MCPClient;
    if (externalConfig.transport === 'stdio') {
      client = new MCPClient({
        id: `troubleshoot-external-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        timeout: externalConfig.timeout_seconds * 1000,
        registerProcessHooks: false,
        servers: {
          [serverName]: {
            command: externalConfig.command!,
            args: externalConfig.args,
            cwd: externalConfig.cwd ? resolve(projectRoot, externalConfig.cwd) : projectRoot,
            stderr: 'pipe',
            timeout: externalConfig.timeout_seconds * 1000,
          },
        },
      });
    } else {
      const endpoint = new URL(externalConfig.url!);
      const token = externalConfig.token_env ? process.env[externalConfig.token_env] : undefined;
      if (externalConfig.token_env && !token) {
        return { tools: createExternalKnowledgeToolsForConfig(externalConfig, inputTexts, projectRoot, async () => { throw new Error('external_auth_missing: configured credential is unavailable'); }) };
      }
      client = new MCPClient({
        id: `troubleshoot-external-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        timeout: externalConfig.timeout_seconds * 1000,
        registerProcessHooks: false,
        servers: {
          [serverName]: {
            url: endpoint,
            ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
            logger: () => undefined,
            timeout: externalConfig.timeout_seconds * 1000,
          },
        },
      });
    }
    client.__setLogger(noopLogger);
    let toolsetsPromise: Promise<MastraToolsets> | undefined;
    const call: ExternalToolCall = async (name, args, context) => {
      toolsetsPromise ??= client.listToolsets();
      const toolsets = await toolsetsPromise;
      const upstream = toolsets[serverName] as Record<string, { execute?: (args: Record<string, unknown>, context: unknown) => Promise<unknown> }> | undefined;
      const resolveTool = upstream?.wiki_resolve;
      const readTool = upstream?.wiki_read;
      const tool = name === 'wiki_resolve' ? resolveTool : readTool;
      if (!tool?.execute) throw new Error('external_contract_error: required tool unavailable');
      return decodeExternalMcpResult(await tool.execute(args, context));
    };
    const tools = createExternalKnowledgeToolsForConfig(externalConfig, inputTexts, projectRoot, call);
    return { tools, client };
  }

  async createLogCatalogTools(): Promise<{ tools: LogCatalogTools } | null> {
    try {
      const tools = await createLogCatalogTools(this.config);
      return tools ? { tools } : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    // Knowledge and repository clients are request-scoped and disconnected by the route.
  }
}
