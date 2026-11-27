import type {
  ClientPlatform,
  ClientFormFactor,
  ClientProductLine,
  ConversationRecord,
} from '../domain/schemas.js';

export type PromptSourceContext = {
  platform: ClientPlatform | null;
  productLine: ClientProductLine | null;
  formFactor: ClientFormFactor | null;
  version: string | null;
  build: string | null;
};

export class PromptVersionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptVersionContextError';
  }
}

const VERSION_PATTERN = /(?<!\d)v?(\d+\.\d+\.\d+(?:\.\d+)?)(?!\d)/gi;
const BUILD_PATTERN = /(?:build|构建(?:号)?)[\s:=：-]*([A-Za-z0-9][A-Za-z0-9._-]*)/i;
const TAG_BUILD_PATTERN = /v?\d+\.\d+\.\d+-(\d+)(?:-|\b)/i;

/**
 * 「非/不是/而非 + 平台或形态词」是否定表述（如「安卓端手机版（非 HD/平板）」），
 * 匹配前剥掉整段（含「HD/平板」这类顿号斜杠续接），否则否定语境会被当成肯定命中。
 */
const PLATFORM_OR_FORM_WORD = '鸿蒙|HarmonyOS?|OpenHarmony|安卓|Android|iOS|苹果系统|iPhone|iPad|平板|pad|手机|phone|HD';
const NEGATED_SEGMENT = new RegExp(
  `(?:而非|而不是|不是|非|不用|不支持|非仅)\\s*(?:${PLATFORM_OR_FORM_WORD})(?:\\s*[/、和或]\\s*(?:${PLATFORM_OR_FORM_WORD}))*`,
  'gi',
);

function stripNegated(content: string): string {
  return content.replace(NEGATED_SEGMENT, ' ');
}

function detectPlatform(content: string): ClientPlatform | null {
  const cleaned = stripNegated(content);
  const patterns: Array<{ platform: ClientPlatform; pattern: RegExp }> = [
    { platform: 'harmony', pattern: /鸿蒙|HarmonyOS?|OpenHarmony/gi },
    { platform: 'android', pattern: /安卓|Android/gi },
    { platform: 'ios', pattern: /\biOS\b|苹果系统|iPhone|iPad/gi },
  ];
  const active = patterns.flatMap(({ platform, pattern }) => {
    const mentions: Array<{ index: number; end: number }> = [];
    for (const match of cleaned.matchAll(pattern)) {
      if (match.index === undefined) continue;
      mentions.push({ index: match.index, end: match.index + match[0].length });
    }
    return mentions
      .filter((mention) => !isComparisonPlatformMention(cleaned, mention.index, mention.end))
      .map(() => platform);
  });
  // A sentence such as "HarmonyOS is affected, Android is not reproduced"
  // names two platforms but only one is the source-selection target. Keep
  // genuine multi-platform incidents ambiguous and ask for clarification.
  return uniqueOrThrow(active, '平台') ?? null;
}

function isComparisonPlatformMention(content: string, index: number, end: number): boolean {
  const before = content.slice(Math.max(0, index - 24), index);
  const boundary = content.slice(end).search(/[，。！？；,!?;\n]/);
  const after = content.slice(end, boundary < 0 ? content.length : end + boundary);
  const shortAfter = content.slice(end, Math.min(content.length, end + 12));
  const comparison = /(?:未|没|没有|不曾|暂未|无法)\s*(?:复现|出现|发现|报错|有问题|异常)/i;
  const normal = /(?:正常|无异常|无问题|没问题|可用|不受影响)/i;
  return comparison.test(after)
    || normal.test(after)
    || comparison.test(shortAfter)
    || normal.test(shortAfter)
    || (/(?:对比|相比|相较于|而|但|但是|其他|另外|另一个)\s*$/i.test(before)
      && (comparison.test(after) || normal.test(after)));
}

function detectProductLine(content: string): ClientProductLine | null {
  const matches = [
    /学而思(?!云)|xueersi/i.test(content) ? 'xueersi' : null,
    /学家云|云学习|xuejiayun/i.test(content) ? 'xuejiayun' : null,
  ].filter((value): value is ClientProductLine => value !== null);
  return uniqueOrThrow(matches, '产品线') ?? null;
}

function detectFormFactor(content: string): ClientFormFactor | null {
  const cleaned = stripNegated(content);
  const matches = [
    /平板|iPad|pad|(?:学而思|学家云)\s*HD\b|(?:^|[\s_-])HD(?:$|[\s_-])/i.test(cleaned) ? 'pad' : null,
    /手机|phone/i.test(cleaned) ? 'phone' : null,
  ].filter((value): value is ClientFormFactor => value !== null);
  // 双命中（如「手机和平板都不行」）与产品线多命中同规则：抛歧义让上游追问，不静默二选一。
  return uniqueOrThrow(matches, '端形态') ?? null;
}

function detectVersion(content: string): string | null {
  const versions = [...content.matchAll(VERSION_PATTERN)].map((match) => match[1]!).filter(Boolean);
  return uniqueOrThrow(versions, '版本号') ?? null;
}

function detectBuild(content: string, version: string | null): string | null {
  const explicit = content.match(BUILD_PATTERN)?.[1];
  if (explicit) return explicit;
  if (!version) return null;
  return content.match(TAG_BUILD_PATTERN)?.[1] ?? null;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').replace(/^(\d+\.\d+\.\d+)(?:\.\d+)?$/, '$1');
}

function uniqueOrThrow<T extends string>(values: readonly T[], label: string): T | undefined {
  const unique = [...new Set(values)];
  if (unique.length > 1) throw new PromptVersionContextError(`提示词中的${label}存在歧义：${unique.join('、')}`);
  return unique[0];
}

/** Resolve explicit prompt context, falling back to the session's selected scope. */
export function resolvePromptSourceContext(
  content: string,
  conversation: Pick<ConversationRecord, 'platform' | 'product_line' | 'form_factor' | 'version' | 'build'>
    & { workspace_path?: string | null; promptHistory?: readonly string[] },
): PromptSourceContext | null {
  const currentPlatform = detectPlatform(content);
  const currentProductLine = detectProductLine(content);
  const currentFormFactor = detectFormFactor(content);
  const currentVersion = detectVersion(content);
  const previousMessages = [...(conversation.promptHistory ?? [])].reverse();
  const historyPlatform = firstDetected(previousMessages, detectPlatform);
  const historyProductLine = firstDetected(previousMessages, detectProductLine);
  const historyFormFactor = currentPlatform && historyPlatform && currentPlatform !== historyPlatform
    ? null
    : firstDetected(previousMessages, detectFormFactor);
  const historyVersion = currentPlatform && historyPlatform && currentPlatform !== historyPlatform
    ? null
    : firstDetected(previousMessages, detectVersion);
  const platform = currentPlatform ?? historyPlatform ?? conversation.platform;
  // 产品线未指明时默认学而思（C 端主 App）：消除「命中多个产品线」的绑定失败；
  // 用户明确说是学家云时检测值优先，永远压过默认值。
  const productLine = currentProductLine ?? historyProductLine ?? conversation.product_line ?? 'xueersi';
  const formFactor = currentFormFactor ?? historyFormFactor ?? conversation.form_factor;
  const version = currentVersion ?? historyVersion ?? conversation.version;
  const build = detectBuild(content, version)
    ?? (currentPlatform && historyPlatform && currentPlatform !== historyPlatform ? null : conversation.build);

  // 一致性检查只对「已成功绑定」的会话执行：已绑定的 scope 是已确认事实，新消息
  // 提到不同值是真矛盾（追问澄清）；绑定失败的残留只是上次未成的猜测，用户改口/
  // 换版本重试时必须让当前消息优先，否则「继续核查后换版本重试」会被永远打回。
  const scopeConfirmed = Boolean(conversation.workspace_path);
  if (scopeConfirmed && conversation.platform && detectPlatform(content) && conversation.platform !== platform) {
    throw new PromptVersionContextError(`提示词平台与会话平台不一致：${conversation.platform} / ${platform}`);
  }
  if (scopeConfirmed && conversation.product_line && detectProductLine(content) && conversation.product_line !== productLine) {
    throw new PromptVersionContextError(`提示词产品线与会话产品线不一致：${conversation.product_line} / ${productLine}`);
  }
  if (scopeConfirmed && conversation.form_factor && currentFormFactor && conversation.form_factor !== currentFormFactor) {
    throw new PromptVersionContextError(`提示词端形态与会话端形态不一致：${conversation.form_factor} / ${currentFormFactor}`);
  }
  if (scopeConfirmed && conversation.version && currentVersion && normalizeVersion(conversation.version) !== normalizeVersion(currentVersion)) {
    throw new PromptVersionContextError(`提示词版本与会话版本不一致：${conversation.version} / ${currentVersion}`);
  }
  if (scopeConfirmed && conversation.build && currentBuild(content, currentVersion) && conversation.build !== currentBuild(content, currentVersion)) {
    throw new PromptVersionContextError(`提示词构建与会话构建不一致：${conversation.build} / ${currentBuild(content, currentVersion)}`);
  }
  if (!platform && !productLine && !formFactor && !version && !build) return null;
  return { platform, productLine, formFactor, version, build };
}

function currentBuild(content: string, version: string | null): string | null {
  return detectBuild(content, version);
}

function firstDetected<T>(messages: readonly string[], detector: (content: string) => T | null): T | null {
  for (const message of messages) {
    const value = detector(message);
    if (value !== null) return value;
  }
  return null;
}
