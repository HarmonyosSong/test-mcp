import type { ConversationRecord } from '../domain/schemas.js';
import type { RunDiagnosisRoundOptions } from '../diagnosis/run-round.js';
import { PromptVersionContextError, resolvePromptSourceContext } from './prompt-version-context.js';
import { clearIncompleteSourceBinding, hasCompleteSourceBinding, needsIosComponents } from './source-binding.js';

/** Runs after admission/stream start, shared by Web and IM. */
export async function prepareConversationSource(
  conversation: ConversationRecord,
  content: string,
  bind: RunDiagnosisRoundOptions['createConversationSource'],
  signal?: AbortSignal,
): Promise<void> {
  if (!bind) return;
  clearIncompleteSourceBinding(conversation);
  // Older rounds substituted the latest registered Harmony/Android release. Retry the
  // incident version at the next round boundary; old evidence keeps its own
  // immutable source identity, but the wrong workspace must not stay mounted.
  if ((conversation.platform === 'harmony' || conversation.platform === 'android') && conversation.version
    && conversation.source_limitations.some((value) => /现场版本.*未登记.*作为源码对照/.test(value))) {
    conversation.workspace_path = null;
    clearIncompleteSourceBinding(conversation);
  }
  const bound = hasCompleteSourceBinding(conversation);
  if (bound && !needsIosComponents(conversation)) return;
  try {
    const scope = resolvePromptSourceContext(content, {
      ...conversation,
      promptHistory: conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    });
    if (!scope) return;
    Object.assign(conversation, {
      ...(scope.platform ? { platform: scope.platform } : {}),
      ...(scope.productLine ? { product_line: scope.productLine } : {}),
      ...(scope.formFactor ? { form_factor: scope.formFactor } : {}),
      ...(scope.version ? { version: scope.version } : {}),
      ...(scope.build ? { build: scope.build } : {}),
    });
    if (!scope.platform) return;
    const source = await bind({
      platform: scope.platform, productLine: scope.productLine, formFactor: scope.formFactor,
      version: scope.version, build: scope.build,
      ...(bound ? { boundSource: { repositories: conversation.source_repositories, limitations: conversation.source_limitations } } : {}),
      signal,
    });
    Object.assign(conversation, source);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PromptVersionContextError) {
      conversation.source_limitations = ['源码绑定所需上下文暂未唯一确定，本轮先查询关联日志或追问缺失信息。'];
    } else {
      // 版本未登记/仓库故障/物化层错误都是可消化的绑定失败：写成可读 limitation 供模型调整重试。
      // 与显式绑定路径同一工具合同（返回缺口文案，不裸抛 {"name":"Error"}）。
      conversation.source_limitations = [`源码快照暂未绑定：${error instanceof Error ? error.message : String(error)}。本轮先查询关联日志，补齐范围后自动重试。`];
    }
  }
}
