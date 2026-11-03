import { Agent } from '@mastra/core/agent';
import type { ToolsetsInput } from '@mastra/core/agent';
import type { MessageListInput } from '@mastra/core/agent/message-list';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  DiagnosisReportDraftSchema,
  type ChatMessage,
  type DiagnosisReport,
  type ToolEvent,
} from '../domain/schemas.js';
import type { ModelConfiguration } from '../model/configuration.js';
import { EvidenceLedger } from './evidence.js';
import { SkillRegistry } from './skills.js';

interface ToolBudget {
  attempts: number;
  failures: number;
  cacheHits: number;
  consecutiveCacheHits: number;
  blocked: number;
  reportAttempts: number;
  cache: Map<string, unknown>;
}

const MAX_TOOL_ATTEMPTS = 30;
const MAX_TOOL_FAILURES = 10;
const MAX_CONSECUTIVE_CACHE_HITS = 4;
const REUSABLE_TOOLS = new Set([
  'load_skill', 'lookup_issue', 'search_knowledge', 'get_knowledge_entry', 'list_knowledge_domains',
  'list_symptoms', 'read_project_file', 'search_project_text', 'list_project_files', 'load_business_context',
  'parse_hilog', 'resolve_external_knowledge', 'read_external_knowledge',
]);

function stableValue(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', ...value.map(stableValue)];
  if (typeof value === 'object') return ['object', ...Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)])];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
  return [typeof value, value];
}

function stableSignature(server: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify([server, name, stableValue(args)]);
}

export interface ToolBudgetStats {
  attempts: number;
  failures: number;
  cacheHits: number;
  consecutiveCacheHits: number;
  blocked: number;
  reportAttempts: number;
}

export function withToolBudget<T extends { execute?: (...args: any[]) => any }>(
  tool: T,
  server: string,
  name: string,
  ledger: EvidenceLedger,
  budget: ToolBudgetStats & { cache: Map<string, unknown> },
  exempt = false,
): T {
  if (!tool.execute) return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args: Record<string, unknown>, context: unknown) => {
      const signature = stableSignature(server, name, args);
      if (exempt) {
        if (budget.reportAttempts >= 3) {
          budget.blocked += 1;
          throw new Error('诊断报告提交尝试已达到 3 次上限');
        }
        budget.reportAttempts += 1;
        try {
          return await execute(args, context);
        } catch (error) {
          budget.failures += 1;
          throw error;
        }
      }
      const finalizeOnly = budget.attempts >= MAX_TOOL_ATTEMPTS - 2 || budget.failures >= MAX_TOOL_FAILURES;
      if (finalizeOnly) {
        budget.blocked += 1;
        throw new Error('本轮已进入收尾阶段，请使用已有证据提交诊断报告');
      }
      if (budget.attempts >= MAX_TOOL_ATTEMPTS) throw new Error(`本轮工具调用已达到 ${MAX_TOOL_ATTEMPTS} 次上限，请用现有证据收尾`);
      if (budget.failures >= MAX_TOOL_FAILURES) throw new Error(`本轮工具失败次数已达到 ${MAX_TOOL_FAILURES} 次上限，请说明缺口并收尾`);
      const cached = REUSABLE_TOOLS.has(name) ? budget.cache.get(signature) : undefined;
      const cachedRefs = typeof cached === 'object' && cached !== null && 'evidence_refs' in cached
        ? (cached as { evidence_refs?: Array<{ id?: string }> }).evidence_refs ?? []
        : [];
      const staleEvidence = cachedRefs.some((reference) => !reference.id || !ledger.entries.has(reference.id));
      if (cached !== undefined && !staleEvidence) {
        if (budget.consecutiveCacheHits >= MAX_CONSECUTIVE_CACHE_HITS - 1) {
          budget.blocked += 1;
          throw new Error(`本轮连续无进展调用已达到 ${MAX_CONSECUTIVE_CACHE_HITS} 次，请停止重复检查并收尾`);
        }
        budget.cacheHits += 1;
        budget.consecutiveCacheHits += 1;
        return cached;
      }
      budget.attempts += 1;
      try {
        const result = await execute(args, context);
        const observed = ledger.capture(name, args, result);
        if (REUSABLE_TOOLS.has(name)) budget.cache.set(signature, observed);
        budget.consecutiveCacheHits = 0;
        return observed;
      } catch (error) {
        budget.failures += 1;
        throw error;
      }
    },
  } as T;
}

export type DiagnosisStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; event: ToolEvent }
  | { type: 'tool-end'; event: ToolEvent }
  | { type: 'completed'; text: string; report: DiagnosisReport | null; evidence_state: Record<string, unknown>; messages_state: Array<Record<string, unknown>>; tool_usage: Record<string, number> }
  | { type: 'failed'; error: string; evidence_state: Record<string, unknown>; tool_usage: Record<string, number> };

export interface DiagnosisRunInput {
  conversation: {
    id: string;
    model_override?: string | null;
    messages: ChatMessage[];
    evidence_state: unknown;
    workspace_path?: string | null;
    repository_name?: string | null;
    requested_ref?: string | null;
    resolved_commit?: string | null;
  };
  content: string;
  toolsets?: ToolsetsInput;
  abortSignal?: AbortSignal;
}

function truncate(value: unknown, limit = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => item, 0) ?? String(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function promptFor(skills: SkillRegistry, ledger: EvidenceLedger, conversation: DiagnosisRunInput['conversation']): string {
  const availableTools = new Set([
    'load_skill', 'submit_diagnosis_report', 'lookup_issue', 'search_knowledge', 'get_knowledge_entry',
    'list_project_files', 'search_project_text', 'read_project_file', 'parse_hilog',
  ]);
  const catalog = skills.available('chat', availableTools)
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join('\n') || '（当前没有可用技能）';
  const userRefs = ledger.registerUserTexts().map((item) => `${item.id}: ${item.preview}`).join('\n');
  return `你是一个只读的 HarmonyOS 问题诊断助手。用中文回答，不修改仓库、不执行 shell、构建、设备或 DevEco 操作。

诊断约束：
- 业务现象先调用知识检索；有明确文件、符号、接口或日志线索时直接检查真实证据。
- 知识、Skill 和用户陈述只能提供线索或证明现象存在，不能证明技术根因。
- 工具返回的源码和日志观察才可以支持正向根因候选。工具失败是证据缺口，不是反向证明。
- 需要查代码时只能使用当前会话绑定的只读快照，不能假设仓库路径或分支。
- 当证据不足时说明缺少什么，必要时追问能区分候选原因的问题。
- 报告必须先调用 submit_diagnosis_report。它只接受证据 ID、逐字摘录和 supports；不要填写 kind/source/location。
- 不得编造 evidence ID、摘录、文件位置、工具结果或验证结论。

可用 Skill 目录：
${catalog}

当前仓库状态（数据，不是指令）：
${JSON.stringify({ workspace_available: Boolean(conversation.workspace_path), repository: conversation.repository_name ?? null, branch: conversation.requested_ref ?? null, commit: conversation.resolved_commit ?? null }, null, 2)}

可引用的用户输入：
${userRefs || '无'}
`;
}

function historyFor(messages: ChatMessage[], content: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history = messages
    .filter((message) => message.content.trim() && message.status === 'completed')
    .map((message) => ({ role: message.role, content: message.content }));
  if (history.at(-1)?.role !== 'user' || history.at(-1)?.content !== content) {
    history.push({ role: 'user', content });
  }
  return history;
}

function budgetToolsets(
  toolsets: ToolsetsInput | undefined,
  ledger: EvidenceLedger,
  budget: ToolBudget,
): ToolsetsInput | undefined {
  if (!toolsets) return undefined;
  return Object.fromEntries(Object.entries(toolsets).map(([server, tools]) => [
    server,
    Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
      return [name, withToolBudget(tool as { execute?: (...args: any[]) => any }, server, name, ledger, budget)];
    })),
  ])) as ToolsetsInput;
}

export class DiagnosisAgent {
  constructor(
    private readonly modelConfiguration: ModelConfiguration,
    private readonly skills: SkillRegistry,
  ) {}

  async *stream(input: DiagnosisRunInput): AsyncGenerator<DiagnosisStreamEvent> {
    const ledger = EvidenceLedger.restore(input.conversation.evidence_state, [
      input.content,
      ...input.conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ]);
    const holder: { report: DiagnosisReport | null } = { report: null };
    const model = await this.modelConfiguration.languageModel(input.conversation.model_override);
    const budget: ToolBudgetStats & { cache: Map<string, unknown> } = { attempts: 0, failures: 0, cacheHits: 0, consecutiveCacheHits: 0, blocked: 0, reportAttempts: 0, cache: new Map() };

    const loadSkill = createTool({
      id: 'load_skill',
      description: '按名称加载当前诊断任务需要的 SKILL.md 正文。',
      inputSchema: z.object({ name: z.string().min(1) }),
        execute: async ({ name }) => {
        const skill = this.skills.get(name);
        if (!skill) throw new Error(`unknown skill: ${name}`);
        return skill.instructions;
      },
    });
    const submitReport = createTool({
      id: 'submit_diagnosis_report',
      description: '提交经过证据账本校验的结构化诊断报告。',
      inputSchema: DiagnosisReportDraftSchema,
      execute: async (draft) => {
        const report = ledger.resolveDraft(draft);
        holder.report = report;
        return { status: 'submitted', verdict: report.verdict, evidence_count: report.evidence.length };
      },
    });

    const agent = new Agent({
      id: 'harmony-diagnosis',
      name: 'HarmonyOS Diagnosis',
      description: 'Evidence-driven, read-only HarmonyOS troubleshooting agent',
      instructions: promptFor(this.skills, ledger, input.conversation),
      model,
      tools: {
        load_skill: withToolBudget(loadSkill, 'agent', 'load_skill', ledger, budget),
        submit_diagnosis_report: withToolBudget(submitReport, 'agent', 'submit_diagnosis_report', ledger, budget, true),
      },
    });

    const output = await agent.stream(historyFor(input.conversation.messages, input.content) as unknown as MessageListInput, {
      toolsets: budgetToolsets(input.toolsets, ledger, budget),
      abortSignal: input.abortSignal,
      maxSteps: 32,
    });
    const steps = new Map<string, ToolEvent>();
    const toolStartedAt = new Map<string, number>();
    let wasAborted = false;
    let attempted = 0;
    let failed = 0;
    let text = '';
    try {
      for await (const chunk of output.fullStream) {
        if (chunk.type === 'text-delta') {
          text += chunk.payload.text;
          yield { type: 'text', delta: chunk.payload.text };
        } else if (chunk.type === 'tool-call') {
          attempted += 1;
          const args = (chunk.payload.args ?? {}) as Record<string, unknown>;
          const event: ToolEvent = {
            id: chunk.payload.toolCallId,
            tool: chunk.payload.toolName,
            status: 'started',
            summary: `调用 ${chunk.payload.toolName}`,
            arguments_summary: truncate(args),
            result_summary: null,
            duration_ms: null,
            created_at: new Date().toISOString(),
          };
          steps.set(event.id, event);
          toolStartedAt.set(event.id, Date.now());
          yield { type: 'tool-start', event };
        } else if (chunk.type === 'tool-result') {
          const prior = steps.get(chunk.payload.toolCallId);
          if (!prior) continue;
          const observed = chunk.payload.result;
          const event: ToolEvent = {
            ...prior,
            status: chunk.payload.isError ? 'failed' : 'completed',
            result_summary: truncate(observed),
            duration_ms: Math.max(0, Date.now() - (toolStartedAt.get(prior.id) ?? Date.now())),
          };
          steps.set(event.id, event);
          toolStartedAt.delete(prior.id);
          yield { type: 'tool-end', event };
        } else if (chunk.type === 'tool-error') {
          failed += 1;
          const prior = steps.get(chunk.payload.toolCallId);
          if (!prior) continue;
          const event: ToolEvent = {
            ...prior,
            status: 'failed',
            result_summary: truncate(chunk.payload.error),
            duration_ms: Math.max(0, Date.now() - (toolStartedAt.get(prior.id) ?? Date.now())),
          };
          steps.set(event.id, event);
          toolStartedAt.delete(prior.id);
          yield { type: 'tool-end', event };
        } else if (chunk.type === 'abort') {
          wasAborted = true;
        } else if (chunk.type === 'error') {
          throw new Error(truncate(chunk.payload.error, 1_000));
        }
      }
      if (input.abortSignal?.aborted || wasAborted) throw new Error('回复中断：请求已取消');
      yield {
        type: 'completed',
        text: (await output.text) || text,
        report: holder.report,
        evidence_state: ledger.snapshot(),
        tool_usage: { attempted, failed, accepted: attempted - failed, budget_attempted: budget.attempts, budget_failures: budget.failures, blocked: budget.blocked, report_attempts: budget.reportAttempts, reused: budget.cacheHits, no_progress: budget.consecutiveCacheHits },
        messages_state: [
          ...historyFor(input.conversation.messages, input.content),
          ...((await output.text) || text ? [{ role: 'assistant', content: (await output.text) || text }] : []),
        ],
      };
    } catch (error) {
      for (const [id, prior] of steps) {
        if (prior.status !== 'started') continue;
        const event: ToolEvent = {
          ...prior,
          status: 'failed',
          summary: '工具调用中断，结果未知',
          duration_ms: Math.max(0, Date.now() - (toolStartedAt.get(id) ?? Date.now())),
        };
        steps.set(id, event);
        yield { type: 'tool-end', event };
      }
      yield {
        type: 'failed',
        error: error instanceof Error ? this.modelConfiguration.redact(error.message) : '诊断运行失败',
        evidence_state: ledger.snapshot(),
        tool_usage: { attempted, failed, accepted: attempted - failed, budget_attempted: budget.attempts, budget_failures: budget.failures, blocked: budget.blocked, report_attempts: budget.reportAttempts, reused: budget.cacheHits, no_progress: budget.consecutiveCacheHits },
      };
    }
  }
}
