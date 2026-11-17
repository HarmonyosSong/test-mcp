import { z } from 'zod';

import { createTool } from '@mastra/core/tools';
import type { ToolsetsInput } from '@mastra/core/agent';

import type { CapabilityMcp, MastraToolsets } from './mcp.js';

/**
 * 懒源码会话：解决 Mastra toolsets 在 agent.stream 调用时固定、轮内不可热插拔的约束。
 *
 * 轮首即注册一组代理工具（schema 静态、与 repository MCP 工具合同一致）；
 * execute 时从持有器解析当前真实会话——未绑定返回 unbound 提示（软指引，
 * 替代原 client-observation-gate 的硬阻断）；prepare_source 绑定成功后
 * 调用 bind() 轮内替换真实会话（串行 dispatch 保证无并发执行）。
 *
 * 双槽位：incident（事故端，默认）+ compare（对照端，跨端实现对比）。
 * 对照端由 prepare_source 显式 platform 参数绑定；代理工具用 target 参数路由。
 */

type RepositorySession = {
  client: { disconnect(): Promise<void> };
  toolsets: MastraToolsets;
};

type ExecutableTool = {
  execute?: (args: Record<string, unknown>, context: unknown) => Promise<unknown>;
};

export type SourceSlot = 'incident' | 'compare';

const UNBOUND_HINT =
  '当前会话尚未绑定源码快照。请先调用 prepare_source 依据用户描述与已确认日志事实解析并绑定版本快照；' +
  '若仅需分析用户粘贴的日志或知识检索，可直接进行，无需源码。';

const COMPARE_UNBOUND_HINT =
  '对照端源码快照尚未绑定。需要跨端实现对比时，先调用 prepare_source 并传入与事故端不同的 ' +
  'platform（事故端为鸿蒙时传 ios/android，事故端为 iOS 时可传 harmony/android，以此类推）；' +
  '之后源码工具传 target="compare" 查阅对照端。';

export class LazySourceHolder {
  private current: Record<SourceSlot, RepositorySession | null> = { incident: null, compare: null };
  private binding: Record<SourceSlot, Promise<void> | null> = { incident: null, compare: null };

  constructor(
    private readonly provider: Pick<CapabilityMcp, 'createRepositorySession'>,
    private readonly conversationId: string,
  ) {}

  bound(slot: SourceSlot = 'incident'): boolean {
    return this.current[slot] !== null;
  }

  /** 绑定/换绑快照：关旧会话、开新会话。按槽位串行化以避免并发 bind 竞争。 */
  bind(snapshotPath: string, slot: SourceSlot = 'incident'): Promise<void> {
    const task = (this.binding[slot] ?? Promise.resolve()).then(async () => {
      const previous = this.current[slot];
      this.current[slot] = null;
      if (previous) await previous.client.disconnect().catch(() => undefined);
      this.current[slot] = await this.provider.createRepositorySession(this.conversationId, snapshotPath);
    });
    this.binding[slot] = task.catch(() => undefined);
    return task;
  }

  /** 从指定槽位当前会话的全部命名空间里按工具名解析真实工具。 */
  findTool(name: string, slot: SourceSlot = 'incident'): ExecutableTool | null {
    const session = this.current[slot];
    if (!session) return null;
    for (const tools of Object.values(session.toolsets)) {
      const tool = (tools as Record<string, ExecutableTool>)[name];
      if (tool?.execute) return tool;
    }
    return null;
  }

  async close(): Promise<void> {
    const slots: SourceSlot[] = ['incident', 'compare'];
    await Promise.all(slots.map((slot) => this.binding[slot]?.catch(() => undefined)));
    await Promise.all(slots.map(async (slot) => {
      const previous = this.current[slot];
      this.current[slot] = null;
      if (previous) await previous.client.disconnect().catch(() => undefined);
    }));
  }
}

type ProxySpec = {
  description: string;
  schema: z.ZodTypeAny;
  /** 未绑定时的定制提示（默认 UNBOUND_HINT）。 */
  unboundHint?: string;
  /** 是否支持 target 路由（parse_hilog 只面向事故端粘贴日志，不支持）。 */
  routable?: boolean;
};

/** 可路由工具的 target 参数：默认 incident（事故端），compare 走对照端快照。 */
const TARGET_PARAM = {
  target: z.enum(['incident', 'compare']).optional().describe(
    '源码快照路由：默认 incident（事故端）；对照端实现对比时传 compare（需先用 prepare_source 绑定对照端快照）。',
  ),
};

const PROXY_TOOLS: Record<string, ProxySpec> = {
  read_project_file: {
    description:
      'Read a bounded line range from one snapshot text file. When truncated, continue from next_line.',
    schema: z.object({
      relative_path: z.string().min(1),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
      max_chars: z.number().int().positive().optional(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
  search_project_text: {
    description:
      'Search snapshot text files for a literal, case-insensitive string; page via next_cursor.',
    schema: z.object({
      query: z.string().min(1),
      file_glob: z.string().optional(),
      limit: z.number().int().positive().optional(),
      cursor: z.string().nullish(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
  list_project_files: {
    description: 'List text files inside the bound repository snapshot.',
    schema: z.object({
      pattern: z.string().optional(),
      limit: z.number().int().positive().optional(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
  parse_hilog: {
    description: 'Extract error lines and referenced source files from pasted hilog text.',
    schema: z.object({
      log_text: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    unboundHint:
      '未绑定源码快照时 parse_hilog 不可用；用户粘贴的日志已在对话中，可直接阅读分析。' +
      '确需结构化解析并登记观测时，先调用 prepare_source 绑定快照。',
  },
  load_business_context: {
    description: 'Load repository-local skills, contracts, and module references relevant to an issue.',
    schema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
  search_code_symbols: {
    description:
      'Search the optional code graph for symbol candidates; navigation only, always confirm with read_project_file.',
    schema: z.object({
      query: z.string().min(1),
      file_pattern: z.string().optional(),
      limit: z.number().int().positive().optional(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
  get_code_outline: {
    description: 'List indexed symbols in one snapshot file; navigation only, not evidence.',
    schema: z.object({
      relative_path: z.string().min(1),
      limit: z.number().int().positive().optional(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
  trace_code_path: {
    description: 'Find static caller/callee candidates for a symbol in the snapshot.',
    schema: z.object({
      function_name: z.string().min(1),
      direction: z.enum(['inbound', 'outbound']).optional(),
      depth: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      ...TARGET_PARAM,
    }),
    routable: true,
  },
};

const NAVIGATION_ONLY = new Set(['search_code_symbols', 'get_code_outline', 'trace_code_path']);

/** 代理工具组：命名空间与直接挂载 repository MCP 时一致，模型无感知。 */
export function createLazySourceToolset(holder: LazySourceHolder): ToolsetsInput {
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const [name, spec] of Object.entries(PROXY_TOOLS)) {
    tools[name] = createTool({
      id: name,
      description: spec.description,
      inputSchema: spec.schema,
      execute: async (args, context) => {
        // target 是代理层路由参数，下发前剥离（底层 MCP 工具不认识它）。
        const { target, ...rest } = args as Record<string, unknown>;
        const slot: SourceSlot = spec.routable && target === 'compare' ? 'compare' : 'incident';
        const tool = holder.findTool(name, slot);
        if (!tool?.execute) {
          if (holder.bound(slot) && NAVIGATION_ONLY.has(name)) {
            return {
              status: 'unavailable',
              limitation: '代码导航索引未配置或不可用；请回退到 search_project_text 文本搜索。',
            };
          }
          return {
            status: 'unbound',
            limitation: slot === 'compare' ? COMPARE_UNBOUND_HINT : (spec.unboundHint ?? UNBOUND_HINT),
          };
        }
        return tool.execute(rest, context);
      },
    });
  }
  return { repository: tools };
}
