import { resolve } from 'node:path';

import { MCPClient } from '@mastra/mcp';
import type { RuntimeConfig } from '../config.js';

export type MastraToolsets = Awaited<ReturnType<MCPClient['listToolsets']>>;

export class CapabilityMcp {
  private readonly knowledge: MCPClient;
  private initialized: Promise<MastraToolsets> | undefined;

  constructor(private readonly config: RuntimeConfig) {
    this.knowledge = new MCPClient({
      id: 'troubleshoot-odyssey-knowledge',
      timeout: 30_000,
      registerProcessHooks: false,
      servers: {
        knowledge: {
          command: config.mcpCommand,
          args: ['run', '--project', resolve(config.projectRoot, 'mcp_server'), 'harmony-knowledge-mcp'],
          cwd: resolve(config.projectRoot),
          stderr: 'pipe',
          env: {
            HARMONY_AGENT_KNOWLEDGE_ROOT: resolve(config.projectRoot, config.knowledgeRoot),
          },
          timeout: 30_000,
        },
      },
    });
  }

  async knowledgeToolsets(): Promise<MastraToolsets> {
    this.initialized ??= this.discoverKnowledge();
    try {
      return await this.initialized;
    } catch {
      // The external knowledge service is optional; repository inspection can still run.
      this.initialized = undefined;
      return {};
    }
  }

  async knowledgeToolNames(): Promise<string[]> {
    const toolsets = await this.knowledgeToolsets();
    return Object.values(toolsets).flatMap((tools) => Object.keys(tools));
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
          env: { HARMONY_AGENT_MCP_WORKSPACE: resolve(snapshotPath) },
          timeout: 30_000,
        },
      },
    });
    try {
      const discovered = await client.listToolsetsWithErrors({ perServerTimeoutMs: 5_000 });
      if (discovered.errors.repository) {
        throw new Error(`repository MCP unavailable: ${discovered.errors.repository}`);
      }
      return { client, toolsets: discovered.toolsets };
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.knowledge.disconnect();
  }

  private async discoverKnowledge(): Promise<MastraToolsets> {
    const discovered = await this.knowledge.listToolsetsWithErrors({ perServerTimeoutMs: 5_000 });
    if (discovered.errors.knowledge) {
      throw new Error(`knowledge MCP unavailable: ${discovered.errors.knowledge}`);
    }
    return discovered.toolsets;
  }
}
