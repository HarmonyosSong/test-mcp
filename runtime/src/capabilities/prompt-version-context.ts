import type {
  ClientPlatform,
  ClientFormFactor,
  ClientProductLine,
  ConversationRecord,
} from '../domain/schemas.js';
import { LogObservationContextSchema } from '../domain/schemas.js';

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

function detectPlatform(content: string): ClientPlatform | null {
  const patterns: Array<{ platform: ClientPlatform; pattern: RegExp }> = [
    { platform: 'harmony', pattern: /鸿蒙|HarmonyOS?|OpenHarmony/gi },
    { platform: 'android', pattern: /安卓|Android/gi },
    { platform: 'ios', pattern: /\biOS\b|苹果系统|iPhone|iPad/gi },
  ];
  const active = patterns.flatMap(({ platform, pattern }) => {
    const mentions: Array<{ index: number; end: number }> = [];
    for (const match of content.matchAll(pattern)) {
      if (match.index === undefined) continue;
      mentions.push({ index: match.index, end: match.index + match[0].length });
    }
    return mentions
      .filter((mention) => !isComparisonPlatformMention(content, mention.index, mention.end))
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
  if (/平板|iPad|pad|(?:学而思|学家云)\s*HD\b|(?:^|[\s_-])HD(?:$|[\s_-])/i.test(content)) return 'pad';
  if (/手机|phone/i.test(content)) return 'phone';
  return null;
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
    & Partial<Pick<ConversationRecord, 'evidence_state'>>
    & { promptHistory?: readonly string[] },
): PromptSourceContext | null {
  const observed = observedLogContext(conversation.evidence_state ?? {});
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
  const platform = currentPlatform ?? observed.platform ?? historyPlatform ?? conversation.platform;
  const productLine = currentProductLine ?? observed.productLine ?? historyProductLine ?? conversation.product_line;
  const formFactor = currentFormFactor ?? observed.formFactor ?? historyFormFactor ?? conversation.form_factor;
  // Do not carry a Harmony/iOS log version into an explicit Android request
  // (or the reverse); the registry will choose the latest verified build.
  const observedVersion = observed.platform && platform && observed.platform !== platform
    ? null
    : observed.version;
  const version = currentVersion ?? observedVersion ?? historyVersion ?? conversation.version;
  const build = detectBuild(content, version)
    ?? (currentPlatform && historyPlatform && currentPlatform !== historyPlatform ? null : conversation.build);

  if (conversation.platform && detectPlatform(content) && conversation.platform !== platform) {
    throw new PromptVersionContextError(`提示词平台与会话平台不一致：${conversation.platform} / ${platform}`);
  }
  if (conversation.product_line && detectProductLine(content) && conversation.product_line !== productLine) {
    throw new PromptVersionContextError(`提示词产品线与会话产品线不一致：${conversation.product_line} / ${productLine}`);
  }
  if (conversation.form_factor && currentFormFactor && conversation.form_factor !== currentFormFactor) {
    throw new PromptVersionContextError(`提示词端形态与会话端形态不一致：${conversation.form_factor} / ${currentFormFactor}`);
  }
  if (conversation.version && currentVersion && normalizeVersion(conversation.version) !== normalizeVersion(currentVersion)) {
    throw new PromptVersionContextError(`提示词版本与会话版本不一致：${conversation.version} / ${currentVersion}`);
  }
  if (conversation.build && currentBuild(content, currentVersion) && conversation.build !== currentBuild(content, currentVersion)) {
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

function observedLogContext(value: ConversationRecord['evidence_state']): {
  platform: ClientPlatform | null;
  productLine: ClientProductLine | null;
  formFactor: ClientFormFactor | null;
  version: string | null;
} {
  const rawEntries = value.entries;
  if (!Array.isArray(rawEntries)) return { platform: null, productLine: null, formFactor: null, version: null };
  const contexts = rawEntries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('observation_context' in entry)) return [];
    const parsed = LogObservationContextSchema.safeParse(entry.observation_context);
    if (!parsed.success) return [];
    const context = parsed.data;
    if (
      context.platform_conflict ||
      context.service_binding.status !== 'confirmed' ||
      context.matched_identifiers.length === 0
    ) return [];
    return [context];
  });
  const platforms = [...new Set(contexts
    .map((context) => context.observed_platform)
    .filter((platform): platform is ClientPlatform => platform !== 'unknown'))];
  if (platforms.length > 1) {
    throw new PromptVersionContextError(`LogCenter 关联日志的平台存在歧义：${platforms.join('、')}`);
  }
  const productLines = [...new Set(contexts
    .map((context) => context.observed_product_line)
    .filter((productLine): productLine is ClientProductLine => Boolean(productLine)))];
  if (productLines.length > 1) {
    throw new PromptVersionContextError(`LogCenter 关联日志的产品线存在歧义：${productLines.join('、')}`);
  }
  const versions = [...new Set(contexts
    .map((context) => context.observed_version?.trim() || null)
    .filter((version): version is string => Boolean(version)))];
  if (versions.length > 1) {
    throw new PromptVersionContextError(`LogCenter 关联日志的版本存在歧义：${versions.join('、')}`);
  }
  const formFactors = [...new Set(contexts
    .map((context) => context.observed_form_factor)
    .filter((formFactor): formFactor is ClientFormFactor => formFactor !== 'unknown'))];
  if (formFactors.length > 1) {
    throw new PromptVersionContextError(`LogCenter 关联日志的端形态存在歧义：${formFactors.join('、')}`);
  }
  return {
    platform: platforms[0] ?? null,
    productLine: productLines[0] ?? null,
    formFactor: formFactors[0] ?? null,
    version: versions[0] ?? null,
  };
}
