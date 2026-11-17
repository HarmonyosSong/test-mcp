import { z } from 'zod';

import { createTool } from '@mastra/core/tools';

import type { ConversationRecord } from '../domain/schemas.js';
import type { RunDiagnosisRoundOptions } from '../diagnosis/run-round.js';
import { prepareConversationSource } from './prepare-source.js';
import type { LazySourceHolder } from './lazy-source.js';

/**
 * prepare_source：模型触发的源码快照绑定工具。
 *
 * 把现行"轮首固定钩子 + 日志补齐后 Runtime 重跑 source 阶段"的编排，
 * 换成模型自主决定何时绑定：内部仍走 resolvePromptSourceContext（提示词 +
 * 历史用户消息 + 日志观测 observation_context）→ version-registry → 快照物化，
 * 绑定成功后轮内热替换懒源码会话。歧义/缺上下文时返回缺口说明文本（不抛错），
 * 由模型决定先查日志、追问用户还是继续无源码分析。
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
      '返回缺口说明时表示上下文不足：先查询关联日志或向用户追问，再重试。',
    inputSchema: z.object({
      hint: z.string().optional().describe('可选的补充说明（如用户刚确认的版本号），并入解析输入'),
    }),
    execute: async (args) => {
      abortSignal?.throwIfAborted();
      if (!bind) {
        return {
          status: 'unavailable',
          limitation: '源码快照服务未配置，本轮无法查阅源码；可继续知识检索与日志分析。',
        };
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
}
