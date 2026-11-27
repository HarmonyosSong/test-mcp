import { z } from 'zod';

import { createTool } from '@mastra/core/tools';

import type { ConversationRecord } from '../domain/schemas.js';
import type { RunDiagnosisRoundOptions } from '../diagnosis/run-round.js';
import { prepareConversationSource } from './prepare-source.js';
import { clearIncompleteSourceBinding } from './source-binding.js';
import type { LazySourceHolder } from './lazy-source.js';

/**
 * prepare_source：模型触发的源码快照绑定工具。
 *
 * 把现行"轮首固定钩子 + 日志补齐后 Runtime 重跑 source 阶段"的编排，
 * 换成模型自主决定何时绑定：内部仍走 resolvePromptSourceContext（提示词 +
 * 历史用户消息 + 日志观测 observation_context）→ version-registry → 快照物化，
 * 绑定成功后轮内热替换懒源码会话。歧义/缺上下文时返回缺口说明文本（不抛错），
 * 由模型决定先查日志、追问用户还是继续无源码分析。
 *
 * 对照端模式（跨端实现对比）：显式传与事故端不同的 platform 时，不触碰事故
 * scope，按"同版本优先、未登记按对照平台规则回落"绑定对照端快照到 compare
 * 槽位；此后源码工具传 target="compare" 查阅对照端。对照端同时只保留一个
 * 快照，换绑不淘汰已登记观测（观测自带 source_context 身份）。
 */
export function createPrepareSourceTool(options: {
  conversation: ConversationRecord;
  bind: RunDiagnosisRoundOptions['createConversationSource'];
  holder: LazySourceHolder;
  /** 本轮用户消息原文；日志/平台提取的当前输入。 */
  content: string;
  abortSignal?: AbortSignal;
}): ReturnType<typeof createTool> {
  const { conversation, bind, holder, content, abortSignal } = options;
  return createTool({
    id: 'prepare_source',
    description:
      '按用户描述与已确认的日志观测解析平台/产品线/形态/版本，绑定版本登记表中的只读源码快照。' +
      '需要查阅项目源码时调用；绑定成功后 read_project_file/search_project_text 等源码工具立即可用。' +
      '返回缺口说明时表示上下文不足：先查询关联日志或向用户追问，再重试。' +
      '跨端实现对比：显式传 platform（必须与事故平台不同）可绑定对照端快照，' +
      '同版本优先、未登记则回落最近已登记版本并标注；此后源码工具传 target="compare" 查阅对照端。' +
      '事故端可以是任意端，对照端同理。' +
      '事故平台未确定时（无端信息查询、多端规则对比）：显式传 platform 直接把该端绑为事故端，' +
      '版本缺省回落最近已登记版本；此后再传另一 platform 即走对照端分支。',
    inputSchema: z.object({
      hint: z.string().optional().describe('可选的补充说明（如用户刚确认的版本号），并入解析输入'),
      platform: z.enum(['harmony', 'android', 'ios']).optional().describe(
        '显式指定平台；事故平台已确定且与之不同时绑定为对照端快照（事故端 scope 不变），用于跨端实现对比；' +
          '事故平台未确定时直接把该端绑为事故端（无端信息查询、多端对比的首端），绕过文本解析；' +
          '与事故平台相同或缺省时走事故端解析流程',
      ),
      version: z.string().optional().describe(
        '配合 platform 使用指定对照端/显式端版本；缺省时优先事故版本号，未登记则按目标平台规则回落',
      ),
      form_factor: z.enum(['phone', 'pad', 'universal']).optional().describe(
        '端形态（手机/平板）；文本解析出的形态有误时显式纠正（如事故实为手机端却绑到平板仓），缺省沿用会话值',
      ),
    }),
    execute: async (args) => {
      abortSignal?.throwIfAborted();
      if (!bind) {
        return {
          status: 'unavailable',
          limitation: '源码快照服务未配置，本轮无法查阅源码；可继续知识检索与日志分析。',
        };
      }

      // 对照端分支：事故平台已确定且显式指定了不同平台。
      const incidentPlatform = conversation.platform;
      if (args.platform && incidentPlatform && args.platform !== incidentPlatform) {
        return bindCompareSlot(args.platform, args.version);
      }

      // 显式指定分支：事故平台未定时，platform 参数作为直接绑定目标（无端信息查询、
      // 多端规则对比的首绑端）——文本里有多个平台时文本解析必然歧义失败，这条路是
      // 模型唯一能主动推进的绑定方式。绑上后该端即事故端，再传另一 platform 自动走对照端。
      // 事故平台已定且模型显式传了同平台+版本/形态时同走此路：按显式参数重绑事故端——
      // 模型按「换版本重试」指引操作或纠正形态误判时，显式参数不得被文本解析路径静默忽略。
      if (args.platform && (!incidentPlatform || (args.platform === incidentPlatform && (!!args.version?.trim() || !!args.form_factor)))) {
        return bindExplicitSlot(args.platform, args.version, args.form_factor ?? null);
      }

      const extractInput = args.hint ? `${content}\n${args.hint}` : content;
      await prepareConversationSource(conversation, extractInput, bind, abortSignal);

      const workspacePath = conversation.workspace_path;
      if (!workspacePath) {
        return {
          status: 'unresolved',
          platform: conversation.platform ?? null,
          product_line: conversation.product_line ?? null,
          version: conversation.version ?? null,
          build: conversation.build ?? null,
          source_limitations: conversation.source_limitations,
          limitation: '源码绑定所需上下文暂未唯一确定。先查询关联日志确认平台/版本，或向用户追问后重试。',
        };
      }

      await holder.bind(workspacePath);
      return {
        status: 'bound',
        platform: conversation.platform ?? null,
        product_line: conversation.product_line ?? null,
        form_factor: conversation.form_factor ?? null,
        version: conversation.version ?? null,
        build: conversation.build ?? null,
        repositories: (conversation.source_repositories ?? []).map((repository) => ({
          repository_id: repository.repository_id,
          resolved_commit: repository.resolved_commit,
          mount_path: repository.mount_path,
        })),
        source_completeness: conversation.source_completeness ?? null,
        source_limitations: conversation.source_limitations,
      };
    },
  });

  /**
   * 显式平台绑定：事故平台未定时，把模型指定的平台直接绑为事故端。
   * 跳过文本解析（多平台文本必然歧义）；产品线/形态沿用会话已有值（可为空，
   * 由版本登记表按缺省规则解析），版本缺省取会话值再回落最近已登记版本。
   */
  async function bindExplicitSlot(
    platform: 'harmony' | 'android' | 'ios',
    requestedVersion?: string,
    /** 显式形态纠正：缺省（null）沿用会话值。 */
    explicitFormFactor: 'phone' | 'pad' | 'universal' | null = null,
  ): Promise<Record<string, unknown>> {
    const { conversation, bind, holder, abortSignal } = options;
    if (!bind) {
      return { status: 'unavailable', limitation: '源码快照服务未配置，无法绑定源码。' };
    }
    const version = requestedVersion?.trim() || conversation.version || null;
    const formFactor = explicitFormFactor ?? conversation.form_factor;
    try {
      const source = await bind({
        platform,
        // 与解析器同一规则：产品线未指明默认学而思（老会话可能尚无 product_line）。
        productLine: conversation.product_line ?? 'xueersi',
        formFactor,
        version,
        build: null,
        signal: abortSignal,
      });
      if (!source.workspace_path) {
        return {
          status: 'unresolved',
          platform,
          version,
          limitation: `${platform} ${version ?? '最近已登记版本'} 未解析出可用快照；可换版本重试，或继续无源码分析。`,
        };
      }
      // 与 prepareConversationSource 成功路径同构：先写 scope，再并入绑定结果。
      clearIncompleteSourceBinding(conversation);
      // 显式纠正的形态也要落会话：bind 返回不含 scope 字段时，残留的错误形态不得留存。
      Object.assign(conversation, { platform, version, form_factor: formFactor });
      Object.assign(conversation, source);
      await holder.bind(conversation.workspace_path!);
      return {
        status: 'bound',
        explicit: true,
        platform: conversation.platform ?? null,
        product_line: conversation.product_line ?? null,
        form_factor: conversation.form_factor ?? null,
        version: conversation.version ?? null,
        build: conversation.build ?? null,
        repositories: (conversation.source_repositories ?? []).map((repository) => ({
          repository_id: repository.repository_id,
          resolved_commit: repository.resolved_commit,
          mount_path: repository.mount_path,
        })),
        source_completeness: conversation.source_completeness ?? null,
        source_limitations: conversation.source_limitations,
        usage: '已按显式指定的平台绑定事故端快照（未经文本解析）；需要对比第二端时再调 prepare_source 传另一个 platform 绑定对照端。',
      };
    } catch (error) {
      abortSignal?.throwIfAborted();
      const message = error instanceof Error ? error.message : '未知错误';
      return {
        status: 'unresolved',
        platform,
        version,
        limitation: `${platform} 快照绑定失败：${message}。可换版本/平台重试，或继续无源码分析。`,
      };
    }
  }

  /** 绑定对照端快照：只写 conversation.compare_source，事故 scope 一字不动。 */
  async function bindCompareSlot(
    platform: 'harmony' | 'android' | 'ios',
    requestedVersion?: string,
  ): Promise<Record<string, unknown>> {
    const { conversation, bind, holder, abortSignal } = options;
    if (!bind) {
      return { status: 'unavailable', limitation: '源码快照服务未配置，无法绑定对照端。' };
    }
    if (!conversation.product_line) {
      return {
        status: 'unresolved',
        limitation: '事故产品线尚未确定，无法选择对照端仓库；先通过日志或追问确认产品线（学而思/学家云）。',
      };
    }
    const version = requestedVersion?.trim() || conversation.version || null;
    try {
      const source = await bind({
        platform,
        productLine: conversation.product_line,
        formFactor: conversation.form_factor,
        version,
        build: null,
        signal: abortSignal,
      });
      if (!source.workspace_path || !source.repository_id || !source.resolved_commit || !source.requested_ref) {
        return {
          status: 'unresolved',
          limitation: `对照端 ${platform} ${version ?? ''} 未解析出可用快照；可换版本重试或继续事故端分析。`,
        };
      }
      conversation.compare_source = {
        platform,
        product_line: source.product_line ?? conversation.product_line,
        form_factor: source.form_factor ?? conversation.form_factor,
        version: source.version ?? version,
        build: source.build ?? null,
        workspace_path: source.workspace_path,
        repository_id: source.repository_id,
        repository_name: source.repository_name ?? source.repository_id,
        requested_ref: source.requested_ref,
        resolved_commit: source.resolved_commit,
        source_repositories: source.source_repositories ?? [],
        source_completeness: source.source_completeness ?? null,
        source_limitations: source.source_limitations ?? [],
        bound_at: new Date().toISOString(),
      };
      await holder.bind(source.workspace_path, 'compare');
      return {
        status: 'bound_compare',
        compare: {
          platform,
          product_line: conversation.compare_source.product_line,
          form_factor: conversation.compare_source.form_factor,
          version: conversation.compare_source.version,
          build: conversation.compare_source.build,
          repositories: conversation.compare_source.source_repositories.map((repository) => ({
            repository_id: repository.repository_id,
            resolved_commit: repository.resolved_commit,
            mount_path: repository.mount_path,
          })),
          source_completeness: conversation.compare_source.source_completeness,
          source_limitations: conversation.compare_source.source_limitations,
        },
        incident: {
          platform: conversation.platform,
          version: conversation.version,
          build: conversation.build,
        },
        usage: '对照端快照已绑定：源码工具（read_project_file/search_project_text 等）传 target="compare" 查阅对照端实现；' +
          '省略 target 默认事故端。对比结论引用 ev-ID 时必须标注所属平台与版本；对照端版本与事故版本不一致时按「邻近版本参考」表述。',
      };
    } catch (error) {
      abortSignal?.throwIfAborted();
      const message = error instanceof Error ? error.message : '未知错误';
      return {
        status: 'unresolved',
        limitation: `对照端 ${platform} 快照绑定失败：${message}。可继续事故端分析，或换平台/版本重试。`,
      };
    }
  }
}
