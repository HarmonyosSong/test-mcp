import type { ConversationRecord } from '../domain/schemas.js';
import type { RunDiagnosisRoundOptions } from '../diagnosis/run-round.js';
import { PromptVersionContextError, resolvePromptSourceContext } from './prompt-version-context.js';
import { RepositoryGitError } from './repository.js';
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
    } else if (error instanceof RepositoryGitError) {
      conversation.source_limitations = [`源码快照暂未绑定：${error.message}。本轮先查询关联日志，补齐范围后自动重试。`];
    } else throw error;
  }
}
