import { resolve } from 'node:path';

import { MCPClient } from '@mastra/mcp';
import { noopLogger } from '@mastra/core/logger';
import type { RuntimeConfig } from '../config.js';
import { integrationError } from '../observability/integration-log.js';
import { createLearnerLookupTools, type LearnerLookupToolset } from './ucenter.js';

const REPOSITORY_MCP_DEFAULT_TIMEOUT_MS = 30_000;
const CODE_INDEX_PROCESS_GRACE_SECONDS = 10;
export const MCP_TOOL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * A first navigation request can run one index command and one query command.
 * Keep discovery independently bounded by the 15 second call below.
 */
export function repositoryMcpTimeoutMs(
  config: Pick<RuntimeConfig, 'codeIndexCommand' | 'codeIndexTimeoutSeconds'>,
): number {
  if (!config.codeIndexCommand) return REPOSITORY_MCP_DEFAULT_TIMEOUT_MS;
  return (config.codeIndexTimeoutSeconds * 2 + CODE_INDEX_PROCESS_GRACE_SECONDS) * 1_000;
}

export function repositoryServerEnvironment(
  config: RuntimeConfig,
  snapshotPath: string,
): Record<string, string> {
  return {
    HARMONY_AGENT_MCP_WORKSPACE: resolve(snapshotPath),
    // Explicitly pass an empty command so the child cannot inherit an accidental enablement.
    HARMONY_AGENT_CODE_INDEX_COMMAND: config.codeIndexCommand,
    HARMONY_AGENT_CODE_INDEX_MODE: config.codeIndexMode,
    HARMONY_AGENT_CODE_INDEX_TIMEOUT_SECONDS: String(config.codeIndexTimeoutSeconds),
    HARMONY_AGENT_CODE_INDEX_CACHE: resolve(
      config.projectRoot,
      config.codeIndexCacheDir || '.data/codebase-memory',
    ),
  };
}

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

export function codeIndexServerEnvironment(config: RuntimeConfig): Record<string, string> {
  return {
    HARMONY_AGENT_CODE_INDEX_FILE: resolve(config.codeIndexFile),
    HARMONY_AGENT_CODE_INDEX_SCOPE_FILE: resolve(config.codeIndexScopeFile),
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
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: MCP_TOOL_DISCOVERY_TIMEOUT_MS });
      if (discovered.errors.knowledge) throw new Error(`knowledge MCP unavailable: ${discovered.errors.knowledge}`);
      return { client, toolsets: discovered.toolsets };
    } catch {
      await client.disconnect();
      return null;
    }
  }

  async createCodeIndexSession(): Promise<{
    client: MCPClient;
    toolsets: MastraToolsets;
  } | null> {
    const client = new MCPClient({
      id: `troubleshoot-code-index-${Date.now()}`,
      timeout: 15_000,
      registerProcessHooks: false,
      servers: {
        code_index: {
          command: this.config.mcpCommand,
          args: ['run', '--project', resolve(this.config.projectRoot, 'mcp_server'), 'harmony-code-index-mcp'],
          cwd: resolve(this.config.projectRoot),
          stderr: 'pipe',
          logger: () => undefined,
          env: codeIndexServerEnvironment(this.config),
          timeout: 15_000,
        },
      },
    });
    client.__setLogger(noopLogger);
    try {
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: MCP_TOOL_DISCOVERY_TIMEOUT_MS });
      if (discovered.errors.code_index) throw new Error(`code index MCP unavailable: ${discovered.errors.code_index}`);
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
    const timeout = repositoryMcpTimeoutMs(this.config);
    const client = new MCPClient({
      id: `troubleshoot-repository-${conversationId}-${Date.now()}`,
      timeout,
      registerProcessHooks: false,
      servers: {
        repository: {
          command: this.config.mcpCommand,
          args: ['run', '--project', resolve(this.config.projectRoot, 'mcp_server'), 'harmony-repository-mcp'],
          cwd: resolve(this.config.projectRoot),
          stderr: 'pipe',
          logger: () => undefined,
          env: repositoryServerEnvironment(this.config, snapshotPath),
          timeout,
        },
      },
    });
    client.__setLogger(noopLogger);
    try {
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: MCP_TOOL_DISCOVERY_TIMEOUT_MS });
      if (discovered.errors.repository) {
        throw new Error(`repository MCP unavailable: ${discovered.errors.repository}`);
      }
      return { client, toolsets: discovered.toolsets };
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  }

  async createLearnerLookupTools(options: {
    abortSignal?: AbortSignal;
  } = {}): Promise<{ tools: LearnerLookupToolset } | null> {
    try {
      const tools = createLearnerLookupTools(this.config, options);
      return tools ? { tools } : null;
    } catch (error) {
      integrationError('ucenter', 'createLearnerLookupTools failed; tools unavailable this round', error);
      return null;
    }
  }

  async close(): Promise<void> {
    // Knowledge and repository clients are request-scoped and disconnected by the route.
  }
}
