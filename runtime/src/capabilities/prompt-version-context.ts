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
  const matches = [
    /鸿蒙|HarmonyOS?|OpenHarmony/i.test(content) ? 'harmony' : null,
    /安卓|Android/i.test(content) ? 'android' : null,
    /\biOS\b|苹果系统|iPhone|iPad/i.test(content) ? 'ios' : null,
  ].filter((value): value is ClientPlatform => value !== null);
  return uniqueOrThrow(matches, '平台') ?? null;
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
  const formFactor = currentFormFactor ?? historyFormFactor ?? conversation.form_factor;
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
  if (!platform && !productLine && !formFactor && !version && !build) return null;
  return { platform, productLine, formFactor, version, build };
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
  version: string | null;
} {
  const rawEntries = value.entries;
  if (!Array.isArray(rawEntries)) return { platform: null, productLine: null, version: null };
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
  return {
    platform: platforms[0] ?? null,
    productLine: productLines[0] ?? null,
    version: versions[0] ?? null,
  };
}
