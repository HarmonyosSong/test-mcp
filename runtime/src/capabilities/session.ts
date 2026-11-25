import type { ToolsetsInput } from '@mastra/core/agent';

import type { CapabilityMcp } from './mcp.js';

export interface CapabilityContext {
  readonly conversationId: string;
  readonly messageId: string;
  readonly runId: string;
  readonly workspacePath: string | null;
  /** Bound source identity, when this round is attached to a repository snapshot. */
  readonly repositoryId?: string | null;
  readonly resolvedCommit?: string | null;
  readonly abortSignal?: AbortSignal;
  /** 本轮开始时刻（epoch 毫秒）；log-mcp 用它把日志按轮次实时切成独立文件。 */
  readonly roundStartedAtMs?: number;
}

export interface MountedCapability {
  toolsets: ToolsetsInput;
  close?: () => Promise<void>;
}

export interface CapabilityRegistration {
  id: string;
  optional?: boolean;
  create: (context: CapabilityContext) => Promise<MountedCapability | null>;
}

export interface CapabilitySession {
  readonly context: CapabilityContext;
  readonly toolsets: ToolsetsInput;
  readonly unavailable: readonly string[];
  close(): Promise<void>;
}

/** Runtime-owned registrations only; neither models nor HTTP inputs select factories. */
export async function createCapabilitySession(
  registrations: readonly CapabilityRegistration[],
  input: CapabilityContext,
): Promise<CapabilitySession> {
  const controller = new AbortController();
  const context = Object.freeze({
    ...input,
    abortSignal: input.abortSignal
      ? AbortSignal.any([input.abortSignal, controller.signal])
      : controller.signal,
  });
  const toolsets: ToolsetsInput = {};
  const unavailable: string[] = [];
  const mounted: MountedCapability[] = [];
  const ids = new Set<string>();
  const toolNames = new Set<string>();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      controller.abort();
      const results = await Promise.allSettled(mounted.slice().reverse().map(async (item) => item.close?.()));
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'capability cleanup failed');
    })();
    return closing;
  };

  try {
    for (const registration of registrations) {
      context.abortSignal.throwIfAborted();
      if (ids.has(registration.id)) throw new Error(`duplicate capability: ${registration.id}`);
      ids.add(registration.id);
      let capability: MountedCapability | null;
      try {
        capability = await registration.create(context);
      } catch (error) {
        context.abortSignal.throwIfAborted();
        if (!registration.optional) throw error;
        unavailable.push(registration.id);
        continue;
      }
      if (!capability) {
        if (!registration.optional) throw new Error(`required capability unavailable: ${registration.id}`);
        unavailable.push(registration.id);
        continue;
      }
      mounted.push(capability);
      context.abortSignal.throwIfAborted();
      for (const [namespace, tools] of Object.entries(capability.toolsets)) {
        if (Object.hasOwn(toolsets, namespace)) throw new Error(`duplicate capability namespace: ${namespace}`);
        for (const name of Object.keys(tools)) {
          if (toolNames.has(name)) throw new Error(`duplicate capability tool: ${name}`);
          toolNames.add(name);
        }
        toolsets[namespace] = tools;
      }
    }
    context.abortSignal.throwIfAborted();
    return { context, toolsets, unavailable: Object.freeze(unavailable), close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** Shared by Web, IM and evaluation; A2A/Graphify require their own approved registrations. */
export function createRoundCapabilitySession(provider: CapabilityMcp, context: CapabilityContext): Promise<CapabilitySession> {
  const registrations: CapabilityRegistration[] = [{
    id: 'knowledge',
    optional: true,
    create: async ({ conversationId, messageId }) => {
      const session = await provider.createKnowledgeSession(conversationId, messageId);
      return session ? { toolsets: session.toolsets, close: () => session.client.disconnect() } : null;
    },
  }];
  registrations.push({
    id: 'log',
    optional: true,
    create: async ({ conversationId, messageId, runId, roundStartedAtMs }) => {
      const session = await provider.createLogSession(conversationId, messageId, { runId, roundStartedAtMs });
      return session ? { toolsets: session.toolsets, close: () => session.client.disconnect() } : null;
    },
  });
  registrations.push({
    id: 'code_index',
    optional: true,
    create: async () => {
      const session = await provider.createCodeIndexSession();
      return session ? { toolsets: session.toolsets, close: () => session.client.disconnect() } : null;
    },
  });
  if (context.workspacePath) {
    registrations.push({
      id: 'repository',
      create: async ({ conversationId, workspacePath }) => {
        const session = await provider.createRepositorySession(conversationId, workspacePath!);
        return { toolsets: session.toolsets, close: () => session.client.disconnect() };
      },
    });
  }
  registrations.push({
    id: 'learner',
    optional: true,
    create: async ({ abortSignal }) => {
      const session = await provider.createLearnerLookupTools?.({ abortSignal });
      return session ? { toolsets: { learner: session.tools } } : null;
    },
  });
  registrations.push({
    id: 'simulation_login',
    optional: true,
    create: async ({ abortSignal, messageId }) => {
      const session = await provider.createSimulationLoginTools?.({ abortSignal, messageId });
      return session ? { toolsets: { simulation_login: session.tools } } : null;
    },
  });
  return createCapabilitySession(registrations, context);
}
