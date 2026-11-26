import { resolve } from 'node:path';

import { MCPClient } from '@mastra/mcp';
import { noopLogger } from '@mastra/core/logger';
import type { RuntimeConfig } from '../config.js';
import { integrationError } from '../observability/integration-log.js';
import { createLearnerLookupTools, type LearnerLookupToolset } from './ucenter.js';
import { createSimulationLoginTools, type SimulationLoginToolset } from './simulation-login.js';

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

/** log-mcp 轮次头：告诉服务端这一轮从什么时候开始，日志按轮次实时切文件。 */
export const LOG_ROUND_START_HEADER = 'X-Odyssey-Round-Start';
export const LOG_ROUND_LABEL_HEADER = 'X-Odyssey-Round-Label';

/**
 * 生成本轮日志切分所需的请求头。
 *
 * `X-Odyssey-Round-Start` 是 epoch 毫秒，log-mcp 用它命名本轮的
 * `log-mcp-round-YYYY-MM-DD_HH-MM-SS.log`；`X-Odyssey-Round-Label` 只进文件头注释，
 * 便于人肉定位是哪一轮（不含密钥/用户内容）。
 */
export function logRoundHeaders(input: {
  roundStartedAtMs: number;
  conversationId: string;
  messageId: string;
  runId?: string;
}): Record<string, string> {
  const label = [
    input.runId ? `run=${input.runId}` : '',
    `conv=${input.conversationId}`,
    `msg=${input.messageId}`,
  ].filter(Boolean).join(' ');
  return {
    [LOG_ROUND_START_HEADER]: String(Math.floor(input.roundStartedAtMs)),
    [LOG_ROUND_LABEL_HEADER]: label,
  };
}

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

  async createSimulationLoginTools(options: {
    abortSignal?: AbortSignal;
    messageId?: string;
  } = {}): Promise<{ tools: SimulationLoginToolset } | null> {
    try {
      const tools = createSimulationLoginTools(this.config, options);
      return tools ? { tools } : null;
    } catch (error) {
      integrationError('api-mcp', 'createSimulationLoginTools failed; tools unavailable this round', error);
      return null;
    }
  }

  /**
   * 挂载本轮 log-mcp 工具面。
   *
   * 每轮诊断都会新建一个会话，这里把「本轮开始时刻」通过请求头带给 log-mcp：
   * 服务端据此把本轮所有日志实时写进 `log-mcp-round-YYYY-MM-DD_HH-MM-SS.log`，
   * 而不是混进进程启动的那个大文件。`roundStartedAtMs` 缺省取当前时刻。
   */
  async createLogSession(
    conversationId: string,
    messageId: string,
    options: { roundStartedAtMs?: number; runId?: string } = {},
  ): Promise<{
    client: MCPClient;
    toolsets: MastraToolsets;
  } | null> {
    const url = this.config.logMcpUrl.trim();
    if (!url) return null;
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch (error) {
      integrationError('log-mcp', `invalid LOG_MCP_URL: ${url}`, error);
      return null;
    }
    const timeout = this.config.logMcpTimeoutMs;
    const token = this.config.logMcpBearerToken.trim();
    const roundHeaders = logRoundHeaders({
      roundStartedAtMs: options.roundStartedAtMs ?? Date.now(),
      conversationId,
      messageId,
      runId: options.runId,
    });
    const client = new MCPClient({
      id: `troubleshoot-log-${conversationId}-${messageId}`,
      timeout,
      registerProcessHooks: false,
      servers: {
        log: {
          url: endpoint,
          timeout,
          requestInit: {
            headers: token
              ? { Authorization: `Bearer ${token}`, ...roundHeaders }
              : roundHeaders,
          },
        },
      },
    });
    client.__setLogger(noopLogger);
    try {
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: MCP_TOOL_DISCOVERY_TIMEOUT_MS });
      if (discovered.errors.log) throw new Error(`log MCP unavailable: ${discovered.errors.log}`);
      return { client, toolsets: discovered.toolsets };
    } catch {
      await client.disconnect().catch(() => undefined);
      return null;
    }
  }

  async close(): Promise<void> {
    // Knowledge and repository clients are request-scoped and disconnected by the route.
  }
}
