import { resolve } from 'node:path';

import { MCPClient } from '@mastra/mcp';
import { noopLogger } from '@mastra/core/logger';
import type { RuntimeConfig } from '../config.js';
import { integrationError } from '../observability/integration-log.js';
import { createLogCatalogTools, type LogToolCorrelation } from './log-center.js';

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

  async createLogCatalogTools(options: {
    abortSignal?: AbortSignal;
    correlation?: LogToolCorrelation;
  } = {}): Promise<{ tools: LogCatalogTools } | null> {
    try {
      const tools = await createLogCatalogTools(this.config, options);
      return tools ? { tools } : null;
    } catch (error) {
      integrationError('logcenter', 'createLogCatalogTools failed; tools unavailable this round', error);
      return null;
    }
  }

  async close(): Promise<void> {
    // Knowledge and repository clients are request-scoped and disconnected by the route.
  }
}
