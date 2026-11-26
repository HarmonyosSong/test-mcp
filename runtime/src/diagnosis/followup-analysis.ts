import { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';

import type { CapabilityMcp } from '../capabilities/mcp.js';
import { LazySourceHolder, createLazySourceToolset } from '../capabilities/lazy-source.js';
import type { CompassFollowupOutcome } from '../capabilities/consult-tool.js';
import type { ConversationRecord } from '../domain/schemas.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { recordRoundThinking } from '../observability/conversation-span-file-exporter.js';

/**
 * 协查回执后的客户端侧交叉分析（方案 A 的下半场）。
 *
 * 动机：服务端协查常带回"客户端请求里某参数为空/异常"这类新事实，静态拼接转发
 * 并不能回答"客户端为什么会这么传"。本函数在 settle 时跑一次轻量模型轮，
 * 只挂源码工具，把协查结论映射回客户端请求构造代码。
 *
 * 成本控制：
 * - 先让模型判断协查结论是否与客户端代码有关——纯服务端原因直接回哨兵词
 *   （SKIP_SENTINEL），一个工具都不调，本函数返回 null，消息保持原样；
 * - maxSteps/超时硬上限；任何失败（超时/模型异常/空输出）都返回 null，
 *   绝不影响协查结果本身的落库与推送。
 */

export interface FollowupAnalysis {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** 模型判定协查结论为纯服务端原因时的回复前缀（不追加分析段）。 */
const SKIP_SENTINEL = '无需客户端分析';

const MAX_ANALYSIS_CHARS = 1_500;
// 步数上限要同时容纳「源码阅读 + 输出正文」：实测 8 步会被全面阅读耗尽，正文还没写就被截断。
const MAX_STEPS = 14;
const TIMEOUT_MS = 180_000;

const INSTRUCTIONS = `你是客户端源码分析助手。输入是用户的问题原文和一份服务端协查结论（远端 Agent 对服务端日志/代码的核查结果）。

第零步先看协查结论有没有带回新事实。若结论属于「无法定位请求 / 无法核实 / 缺少服务端记录 / 未查到」这类无结论回复，直接回复「${SKIP_SENTINEL}」并加一句理由（协查未带回可映射的新事实），不要调用任何工具——没有分析对象时读源码只会编出臆测。

第一步再判断：协查结论是否与客户端代码有关。以下情形一律视为「与客户端有关」，不得回哨兵词：
- 结论提到客户端请求参数缺失、为空或异常（如"客户端请求体 X 为空""App 端未携带 Y""下单时没有携带 Z"）；
- 结论提到端侧调用方式、操作路径、版本/平台行为差异；
- 结论建议或暗示需要再核查端侧实现。
仅当结论完全是服务端逻辑、配置或数据问题、且与客户端请求构造无关时，才直接回复「${SKIP_SENTINEL}」加一句理由，不要调用任何工具。

判定与客户端有关后，用源码工具定位并阅读客户端的请求构造代码，回答：协查指出的失败参数/行为在客户端哪里构造、什么条件下会出错、为什么用户现场会命中该条件。
阅读控制在 8 次工具调用以内：先 search_project_text 定位构造点，再 read_project_file 读关键段，拿到答案立刻写正文，不要穷尽式阅读；最后一步必须只输出正文、不再调工具。

输出纪律：
- 只输出分析正文（中文，≤400 字），不要标题、不要「判定：」前缀、不要重复协查结论原文；
- 关键结论引用「文件路径:行号」；
- 分析必须锚定协查结论指出的具体事实，且不得与已有观测矛盾（例如日志已证明请求到达服务端并拿到应答时，不得提出"请求可能没发到服务端"类理论）；
- 源码里找不到解释时如实说明「现有源码无法解释该现象」，不要编造。`;

function lastUserText(conversation: ConversationRecord): string {
  return conversation.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
}

/** 去掉模型可能违规带上的判定锚点行，避免污染知音楼判定标签解析。 */
function stripVerdictLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*判定\s*[:：]/.test(line))
    .join('\n')
    .trim();
}

export async function analyzeFollowupWithSource(input: {
  modelConfiguration: ModelConfiguration;
  capabilities: Pick<CapabilityMcp, 'createRepositorySession'>;
  conversation: ConversationRecord;
  outcome: CompassFollowupOutcome;
  /** 挂上后分析轮 trace 才会落盘进调试面板（与主诊断同一个 exporter）。 */
  mastra?: Mastra;
  /** 测试可注入的模型轮实现；缺省走真实 Mastra Agent。 */
  runRound?: (prompt: string) => Promise<FollowupAnalysis | null>;
  /** 跳过/失败原因回调：观测面板据此把"无声的 null"变成可见的跳过事件。 */
  onSkip?: (reason: string) => void;
}): Promise<FollowupAnalysis | null> {
  const { conversation, outcome } = input;
  if (outcome.state !== 'completed' || !outcome.text.trim()) {
    input.onSkip?.('协查未完成或无结论文本');
    return null;
  }
  // 源码快照是分析轮的米：主轮没绑、settle 兜底也没绑上时如实记录，不再混进"无产出"。
  if (!conversation.workspace_path) {
    console.warn('[followup-analysis] 会话未绑定源码快照，跳过客户端侧分析', {
      conversationId: conversation.id,
    });
    input.onSkip?.('会话未绑定源码快照');
    return null;
  }

  const userQuestion = lastUserText(conversation);
  const prompt = [
    `用户问题原文：${userQuestion}`,
    '',
    '服务端协查结论：',
    outcome.text,
  ].join('\n');

  const runRound = input.runRound ?? (async (text: string) => runSourceAnalysisRound({
    modelConfiguration: input.modelConfiguration,
    capabilities: input.capabilities,
    conversation,
    prompt: text,
    mastra: input.mastra,
  }));

  try {
    const result = await runRound(prompt);
    if (!result) {
      console.warn('[followup-analysis] 分析轮无产出（超时/空输出），按纯转发处理');
      input.onSkip?.('分析轮无产出（超时或空输出）');
      return null;
    }
    const cleaned = stripVerdictLines(result.text);
    if (!cleaned || cleaned.startsWith(SKIP_SENTINEL)) {
      console.warn('[followup-analysis] 模型判定为纯服务端原因，跳过客户端侧分析', {
        conversationId: conversation.id,
        preview: cleaned.slice(0, 120),
      });
      input.onSkip?.('模型判定纯服务端原因');
      return null;
    }
    console.warn('[followup-analysis] 客户端侧分析完成', {
      conversationId: conversation.id,
      chars: cleaned.length,
    });
    return {
      text: cleaned.length > MAX_ANALYSIS_CHARS ? `${cleaned.slice(0, MAX_ANALYSIS_CHARS)}…` : cleaned,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (error) {
    // 分析轮是增强项：失败一律回退为纯转发协查结果，但要留痕可查。
    console.warn('[followup-analysis] 分析轮失败，按纯转发处理', {
      conversationId: conversation.id,
      error: error instanceof Error ? error.message : String(error),
    });
    input.onSkip?.(`分析轮异常：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 流内思考捕获：reasoning-delta 按 step-start 分桶累积（与主诊断轮同一模式）。 */
function accumulateThinking(steps: string[], chunk: { type: string; payload?: unknown }): void {
  if (chunk.type === 'step-start') {
    steps.push('');
  } else if (chunk.type === 'reasoning-delta') {
    if (steps.length === 0) steps.push('');
    steps[steps.length - 1] += ((chunk.payload as { text?: string } | undefined)?.text ?? '');
  }
}

/** 真实模型轮：临时绑定会话已挂载的源码快照，小步数、硬超时。 */
async function runSourceAnalysisRound(input: {
  modelConfiguration: ModelConfiguration;
  capabilities: Pick<CapabilityMcp, 'createRepositorySession'>;
  conversation: ConversationRecord;
  prompt: string;
  mastra?: Mastra;
}): Promise<FollowupAnalysis | null> {
  const workspacePath = input.conversation.workspace_path;
  if (!workspacePath) return null;

  const holder = new LazySourceHolder(input.capabilities, input.conversation.id);
  try {
    await holder.bind(workspacePath);
    const model = await input.modelConfiguration.languageModel(input.conversation.model_override);
    const agent = new Agent({
      id: 'followup-source-analysis',
      name: 'Followup Source Analysis',
      instructions: INSTRUCTIONS,
      model,
      // 与主诊断同一个 Mastra：trace 经 ConversationSpanFileExporter 落盘，调试面板可见。
      ...(input.mastra ? { mastra: input.mastra } : {}),
    });
    const output = await agent.stream(input.prompt, {
      toolsets: createLazySourceToolset(holder),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      maxSteps: MAX_STEPS,
      tracingOptions: {
        metadata: {
          conversation_id: input.conversation.id,
          conversation_created_at: input.conversation.created_at ?? null,
          message_id: null,
          purpose: 'compass_followup_analysis',
        },
      },
    });
    const usagePromise = output.usage.catch(() => null);
    let text = '';
    const thinkingSteps: string[] = [];
    try {
      for await (const chunk of output.fullStream) {
        accumulateThinking(thinkingSteps, chunk);
        if (chunk.type === 'text-delta') text += chunk.payload.text;
      }
    } finally {
      // 思考侧通道与 trace 封盘按会话 FIFO 对齐：本轮 span 已起步就记录一次
      // （哪怕全空），否则后续轮的思考会被本轮 trace 错位抢走。仅在挂了
      // mastra（会产生 trace）时记录。
      if (input.mastra) recordRoundThinking(input.conversation.id, thinkingSteps);
    }
    const usage = await usagePromise;
    if (!text.trim()) return null;
    return {
      text,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    };
  } finally {
    await holder.close().catch(() => undefined);
  }
}

// ———— 知音楼综合答复轮：协查回执改发模板 v2 终稿 ————

/**
 * 知音楼渠道的第二轮不转发协查原文，而是把「初步判定 + 协查结论 + 客户端侧分析」
 * 综合成模板 v2（【给支持老师】【问题原因】【补充信息】）终稿——支持老师两轮看到的
 * 都是同一种排版，第二轮才是正式归属结论。无工具单轮，失败回退为系统拼装文案。
 */

const SYNTHESIS_MAX_CHARS = 2_000;
const SYNTHESIS_TIMEOUT_MS = 90_000;

const YACH_SYNTHESIS_INSTRUCTIONS = `你是客服支持场景的答复撰写助手。输入是一次故障排查的全部材料：用户问题原文、客户端侧初步判定、服务端协查结论，以及（可能有的）客户端侧源码补充分析。

任务：综合成一条发给支持老师的最终答复，严格按模板输出，禁止模板外内容：

判定：已定位|可能定位|证据不足|工具异常（四选一，综合全部材料给最终判定，不标"初步"）

**【给支持老师】**<只写一句归属指引：已辨别来源端时写「该问题归属XX端，请同步XX研发同学跟进」；辨别不出时写「暂时无法排查到问题来源端，请补充学员ID/故障时间/截图后再查」>

**【问题原因】**
<按 现象 → 直接原因 → 影响范围 分三段陈述，整体精简即可，不限制每段字数：
- 现象：学员侧观察到的问题表现；
- 直接原因：一句话因果链——哪个端/服务/接口、在什么条件下、出了什么错导致现象，写到支持老师能直接转述给研发的粒度；结论句之后用 markdown 代码块（\`\`\`语言 + 换行）单独成块附支撑证据（代码位置与关键片段、关键错误日志原文，只取关键行，不整段贴日志，不用行内代码混排）。判定为「已定位」时证据必须有日志/源码观测原文照抄；「可能定位」时句首标「推断：」；证据不足时本段写清缺什么，不得硬写一个原因；
- 影响范围：受影响的端/版本/用户面；
不堆砌 ev-ID、工具名等内部标识>

**【补充信息】**
学员ID：<有则填，无则省略该行>
故障时间：<有则填，无则省略该行>
其他备注：<动态补充：临时规避方式、给家长的口径、待核验项等；无则省略该行>

纪律：
- 综合判定以可观测证据为准：协查结论与初步判定冲突时按协查结论写，修正点在【问题原因】里一句带过；
- 材料一致时直接融合为一份结论，不要写"初步判定说过……协查又说……"这类过程对照；
- 不复述排查过程，不输出调用链/工具名/文件路径/ev-ID。`;

/** 初步判定：会话里最后一条非协查回执的 assistant 正文。 */
function preliminaryAnswer(conversation: ConversationRecord): string {
  const assistant = [...conversation.messages].reverse().find(
    (message) => message.role === 'assistant' && !message.content.startsWith('【服务端协查结果】'),
  );
  return assistant?.content ?? '';
}

export async function synthesizeYachFollowupReply(input: {
  modelConfiguration: ModelConfiguration;
  conversation: ConversationRecord;
  outcome: CompassFollowupOutcome;
  /** 客户端侧源码分析正文（纯服务端原因时为 null）。 */
  analysis?: string | null;
  mastra?: Mastra;
  /** 测试可注入的模型轮实现；缺省走真实 Mastra Agent（无工具）。 */
  runRound?: (prompt: string) => Promise<FollowupAnalysis | null>;
  /** 跳过/失败原因回调：观测面板据此把回退拼装文案的原因变成可见事件。 */
  onSkip?: (reason: string) => void;
}): Promise<FollowupAnalysis | null> {
  const { conversation, outcome } = input;
  if (outcome.state !== 'completed' || !outcome.text.trim()) {
    input.onSkip?.('协查未完成或无结论文本');
    return null;
  }

  const prompt = [
    `用户问题原文：${lastUserText(conversation)}`,
    '',
    '客户端侧初步判定：',
    preliminaryAnswer(conversation) || '（无）',
    '',
    '服务端协查结论：',
    outcome.text,
    ...(input.analysis?.trim() ? ['', '客户端侧源码补充分析：', input.analysis.trim()] : []),
  ].join('\n');

  const runRound = input.runRound ?? (async (promptText: string) => {
    const model = await input.modelConfiguration.languageModel(input.conversation.model_override);
    const agent = new Agent({
      id: 'yach-followup-synthesis',
      name: 'Yach Followup Synthesis',
      instructions: YACH_SYNTHESIS_INSTRUCTIONS,
      model,
      ...(input.mastra ? { mastra: input.mastra } : {}),
    });
    const output = await agent.stream(promptText, {
      abortSignal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      maxSteps: 2,
      tracingOptions: {
        metadata: {
          conversation_id: input.conversation.id,
          conversation_created_at: input.conversation.created_at ?? null,
          message_id: null,
          purpose: 'yach_followup_synthesis',
        },
      },
    });
    const usagePromise = output.usage.catch(() => null);
    let text = '';
    const thinkingSteps: string[] = [];
    try {
      for await (const chunk of output.fullStream) {
        accumulateThinking(thinkingSteps, chunk);
        if (chunk.type === 'text-delta') text += chunk.payload.text;
      }
    } finally {
      // 与分析轮同理：span 已起步就记录一次思考，保持 FIFO 对齐。
      if (input.mastra) recordRoundThinking(input.conversation.id, thinkingSteps);
    }
    const usage = await usagePromise;
    if (!text.trim()) return null;
    return { text, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
  });

  try {
    const result = await runRound(prompt);
    const cleaned = result?.text.trim() ?? '';
    // 综合稿必须带判定锚点，否则不是合法模板 v2，回退为系统拼装文案。
    if (!cleaned || !/^\s*判定\s*[:：]/.test(cleaned)) {
      console.warn('[followup-analysis] 综合答复缺判定锚点或无产出，回退拼装文案', {
        conversationId: conversation.id,
        preview: cleaned.slice(0, 120),
      });
      input.onSkip?.('综合轮无产出或缺判定锚点');
      return null;
    }
    console.warn('[followup-analysis] 知音楼综合答复完成', {
      conversationId: conversation.id,
      chars: cleaned.length,
    });
    return {
      text: cleaned.length > SYNTHESIS_MAX_CHARS ? `${cleaned.slice(0, SYNTHESIS_MAX_CHARS)}…` : cleaned,
      inputTokens: result?.inputTokens ?? null,
      outputTokens: result?.outputTokens ?? null,
    };
  } catch (error) {
    console.warn('[followup-analysis] 综合答复轮失败，回退拼装文案', {
      conversationId: conversation.id,
      error: error instanceof Error ? error.message : String(error),
    });
    input.onSkip?.(`综合轮异常：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
