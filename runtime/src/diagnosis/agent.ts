import { Agent } from "@mastra/core/agent";
import type { ToolsetsInput } from "@mastra/core/agent";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import { createTool } from "@mastra/core/tools";
import type { Mastra } from "@mastra/core/mastra";
import { z } from "zod";

import {
  DiagnosisReportDraftSchema,
  type ChatMessage,
  type DiagnosisReport,
  type ToolEvent,
} from "../domain/schemas.js";
import type { ModelConfiguration } from "../model/configuration.js";
import { EvidenceLedger } from "./evidence.js";
import { SkillRegistry } from "./skills.js";
import { CodeLocatorRegistry } from "./locator-guidance.js";

interface ToolBudget {
  attempts: number;
  failures: number;
  cacheHits: number;
  consecutiveCacheHits: number;
  blocked: number;
  reportAttempts: number;
  cache: Map<string, unknown>;
}

const SEARCH_TOOLS = new Set(["search_project_text", "search_knowledge"]);
const DEFAULT_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  search_project_text: { file_glob: "**/*", limit: 10, cursor: null },
  read_project_file: { start_line: 1, end_line: 200, max_chars: 6000 },
  list_project_files: { pattern: "**/*", limit: 100 },
  search_knowledge: { scope: "symptom", limit: 3 },
  get_knowledge_entry: { offset: 0, limit: 2000 },
};

const MAX_TOOL_ATTEMPTS = 30;
const MAX_TOOL_FAILURES = 10;
const MAX_CONSECUTIVE_CACHE_HITS = 4;
export type DiagnosisFailureCategory =
  | "cancelled"
  | "provider_error"
  | "tool_protocol_error"
  | "runtime_error";
const REUSABLE_TOOLS = new Set([
  "load_skill",
  "lookup_issue",
  "search_knowledge",
  "get_knowledge_entry",
  "list_knowledge_domains",
  "list_symptoms",
  "read_project_file",
  "search_project_text",
  "list_project_files",
  "load_business_context",
  "parse_hilog",
  "resolve_log_target",
  "count_cloud_logs",
  "search_cloud_logs",
  "count_logs",
  "query_logs",
]);

const LOG_CATALOG_INSTRUCTIONS = `When remote log catalog tools are available, load the use-log-catalog Skill before calling them. Resolve via resolve_log_target first; use candidate fields and suggested_query from catalog—never invent account/collection/topic/service_id/appid filters. source=aliyun_sls → count_cloud_logs/search_cloud_logs (filter by appid; note Harmony and iOS may share prod-ios store); source=logcenter → count_logs/query_logs. Prefer count before search/query. Vague 安卓/iOS/鸿蒙 may be ambiguous—clarify. Remote hits are optional helpers, not ledger evidence in this phase. Do not replace pasted hilog or source evidence with catalog routing alone.`;

function stableValue(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array", ...value.map(stableValue)];
  if (typeof value === "object")
    return [
      "object",
      ...Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    ];
  if (typeof value === "number" && !Number.isFinite(value))
    return ["number", String(value)];
  return [typeof value, value];
}

function stableSignature(
  server: string,
  name: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify([
    server,
    name,
    stableValue({ ...(DEFAULT_TOOL_ARGS[name] ?? {}), ...args }),
  ]);
}

function transientFailure(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "transient" in error &&
    error.transient === true
  )
    return true;
  if (typeof error === "object" && error !== null && "error" in error) {
    const nested = error.error;
    if (
      typeof nested === "object" &&
      nested !== null &&
      "data" in nested &&
      typeof nested.data === "object" &&
      nested.data !== null &&
      "transient" in nested.data &&
      nested.data.transient === true
    )
      return true;
  }
  try {
    const parsed = JSON.parse(String(error));
    return (
      typeof parsed === "object" && parsed !== null && parsed.transient === true
    );
  } catch {
    return false;
  }
}

function resultFingerprint(name: string, result: unknown): string {
  return `${name}:${JSON.stringify(stableValue(result))}`;
}

function isToolResultError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === true
  );
}

function failureCategory(error: unknown, cancelled: boolean): DiagnosisFailureCategory {
  if (cancelled) return "cancelled";
  let serialized = "";
  try {
    serialized = JSON.stringify(error) ?? "";
  } catch {
    serialized = "";
  }
  const pending = [error];
  const seen = new Set<unknown>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth += 1) {
    const current = pending.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    const name = current instanceof Error ? current.name : "";
    const message = current instanceof Error ? current.message : String(current);
    if (/tool call|tool result|工具调用|工具结果|工具错误/.test(message))
      return "tool_protocol_error";
    if (
      /APICallError|LoadAPIKeyError|NoSuchModelError|RetryError/.test(name) ||
      (typeof current === "object" && "statusCode" in current && typeof current.statusCode === "number") ||
      /AI_APICallError|LoadAPIKeyError|NoSuchModelError|"statusCode"\s*:\s*[45]\d\d|HTTP [45]\d\d/i.test(`${message} ${serialized}`)
    ) return "provider_error";
    if (typeof current === "object") {
      if ("cause" in current) pending.push(current.cause);
      if ("error" in current) pending.push(current.error);
    }
  }
  return "runtime_error";
}

function searchResultKeys(result: unknown): Set<string> {
  const outer =
    typeof result === "object" && result !== null && "result" in result
      ? result.result
      : result;
  const payload =
    typeof outer === "object" && outer !== null && "matches" in outer
      ? outer.matches
      : outer;
  if (!Array.isArray(payload)) return new Set();
  return new Set(
    payload.map((item) => {
      if (typeof item !== "object" || item === null) return String(item);
      if ("path" in item)
        return `${String(item.path)}:${"line" in item ? String(item.line) : ""}`;
      if ("name" in item) return String(item.name);
      return JSON.stringify(item);
    }),
  );
}

export interface ToolBudgetStats {
  attempts: number;
  failures: number;
  failureLimit?: number;
  cacheHits: number;
  consecutiveCacheHits: number;
  blocked: number;
  reportAttempts: number;
  failedSignatures?: Map<string, boolean>;
  resultSignatures?: Set<string>;
  searchSeen?: Map<string, Set<string>>;
  dispatch?: Promise<void>;
}

export function closePendingToolEvents(
  steps: Map<string, ToolEvent>,
  startedAt: Map<string, number>,
  summary: string,
  now = Date.now(),
): ToolEvent[] {
  const closed: ToolEvent[] = [];
  for (const [id, prior] of steps) {
    if (prior.status !== "running") continue;
    const event: ToolEvent = {
      ...prior,
      status: "failed",
      summary,
      result_summary: "工具结果未知",
      duration_ms: Math.max(0, now - (startedAt.get(id) ?? now)),
    };
    steps.set(id, event);
    startedAt.delete(id);
    closed.push(event);
  }
  return closed;
}

export function withToolBudget<T extends { execute?: (...args: any[]) => any }>(
  tool: T,
  server: string,
  name: string,
  ledger: EvidenceLedger,
  budget: ToolBudgetStats & { cache: Map<string, unknown> },
  exempt = false,
  locators = new CodeLocatorRegistry(),
): T {
  if (!tool.execute) return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args: Record<string, unknown>, context: unknown) => {
      const previous = budget.dispatch ?? Promise.resolve();
      let release!: () => void;
      const lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      budget.dispatch = previous.then(() => lock);
      await previous;
      try {
        const signature = stableSignature(server, name, args);
        const failedSignatures = (budget.failedSignatures ??= new Map<
          string,
          boolean
        >());
        const resultSignatures = (budget.resultSignatures ??=
          new Set<string>());
        const searchSeen = (budget.searchSeen ??= new Map<
          string,
          Set<string>
        >());
        if (exempt) {
          if (budget.reportAttempts >= 3) {
            budget.blocked += 1;
            throw new Error("诊断报告提交尝试已达到 3 次上限");
          }
          budget.reportAttempts += 1;
          try {
            return await execute(args, context);
          } catch (error) {
            budget.failures += 1;
            throw error;
          }
        }
        const finalizeOnly =
          budget.attempts >= MAX_TOOL_ATTEMPTS - 2 ||
          budget.failures >= (budget.failureLimit ?? MAX_TOOL_FAILURES);
        if (finalizeOnly) {
          budget.blocked += 1;
          throw new Error("本轮已进入收尾阶段，请使用已有证据提交诊断报告");
        }
        if (budget.attempts >= MAX_TOOL_ATTEMPTS)
          throw new Error(
            `本轮工具调用已达到 ${MAX_TOOL_ATTEMPTS} 次上限，请用现有证据收尾`,
          );
        if (budget.failures >= (budget.failureLimit ?? MAX_TOOL_FAILURES))
          throw new Error(
            `本轮工具失败次数已达到 ${budget.failureLimit ?? MAX_TOOL_FAILURES} 次上限，请说明缺口并收尾`,
          );
        const cached = REUSABLE_TOOLS.has(name)
          ? budget.cache.get(signature)
          : undefined;
        const cachedRefs =
          typeof cached === "object" &&
          cached !== null &&
          "evidence_refs" in cached
            ? ((cached as { evidence_refs?: Array<{ id?: string }> })
                .evidence_refs ?? [])
            : [];
        const staleEvidence = cachedRefs.some(
          (reference) => !reference.id || !ledger.entries.has(reference.id),
        );
        if (cached !== undefined && !staleEvidence) {
          if (budget.consecutiveCacheHits >= MAX_CONSECUTIVE_CACHE_HITS - 1) {
            budget.blocked += 1;
            throw new Error(
              `本轮连续无进展调用已达到 ${MAX_CONSECUTIVE_CACHE_HITS} 次，请停止重复检查并收尾`,
            );
          }
          budget.cacheHits += 1;
          budget.consecutiveCacheHits += 1;
          return cached;
        }
        if (failedSignatures.get(signature) === false) {
          budget.blocked += 1;
          throw new Error(
            "同一调用签名已失败，禁止原样重试；请更换有依据的参数或报告证据缺口",
          );
        }
        budget.attempts += 1;
        const retryingTransientFailure =
          failedSignatures.get(signature) === true;
        try {
          const result = await execute(args, context);
          if (retryingTransientFailure) failedSignatures.set(signature, false);
          let guided = result;
          if (
            [
              "lookup_issue",
              "get_knowledge_entry",
              "search_knowledge",
            ].includes(name)
          )
            locators.register(result);
          if (
            name === "read_project_file" &&
            typeof args.relative_path === "string" &&
            typeof result === "object" &&
            result !== null &&
            "start_line" in result &&
            "end_line" in result &&
            typeof result.start_line === "number" &&
            typeof result.end_line === "number" &&
            result.end_line >= result.start_line
          ) {
            locators.markRead(
              args.relative_path,
              result.start_line,
              result.end_line,
            );
          }
          if (name === "search_project_text") {
            const hint = locators.hint(String(args.query ?? ""));
            if (hint)
              guided =
                typeof result === "object" &&
                result !== null &&
                !Array.isArray(result)
                  ? { ...result, locator_hint: hint }
                  : { matches: result, locator_hint: hint };
          }
          const observed = ledger.capture(name, args, guided);
          const observedResult =
            typeof observed === "object" &&
            observed !== null &&
            "result" in observed
              ? observed.result
              : observed;
          const empty =
            observedResult === null ||
            observedResult === "" ||
            (typeof observedResult === "object" &&
              observedResult !== null &&
              (("hits" in observedResult &&
                Array.isArray(observedResult.hits) &&
                observedResult.hits.length === 0) ||
                ("matches" in observedResult &&
                  Array.isArray(observedResult.matches) &&
                  observedResult.matches.length === 0)));
          let noProgress =
            empty ||
            resultSignatures.has(resultFingerprint(name, observedResult));
          if (SEARCH_TOOLS.has(name)) {
            const keys = searchResultKeys(observed);
            const previous = searchSeen.get(name) ?? new Set<string>();
            if (keys.size > 0 && [...keys].every((key) => previous.has(key)))
              noProgress = true;
            if (keys.size > 0)
              searchSeen.set(name, new Set([...previous, ...keys]));
          }
          if (noProgress) budget.consecutiveCacheHits += 1;
          else budget.consecutiveCacheHits = 0;
          resultSignatures.add(resultFingerprint(name, observedResult));
          if (REUSABLE_TOOLS.has(name)) budget.cache.set(signature, observed);
          if (budget.consecutiveCacheHits >= MAX_CONSECUTIVE_CACHE_HITS) {
            budget.blocked += 1;
            throw new Error(
              `本轮连续无进展调用已达到 ${MAX_CONSECUTIVE_CACHE_HITS} 次，请停止重复检查并收尾`,
            );
          }
          return observed;
        } catch (error) {
          budget.failures += 1;
          failedSignatures.set(
            signature,
            !retryingTransientFailure && transientFailure(error),
          );
          throw error;
        }
      } finally {
        release();
      }
    },
  } as T;
}

export type DiagnosisStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; event: ToolEvent }
  | { type: "tool-end"; event: ToolEvent; evidence_state: Record<string, unknown> }
  | {
      type: "completed";
      text: string;
      report: DiagnosisReport | null;
      evidence_state: Record<string, unknown>;
      messages_state: Array<Record<string, unknown>>;
      input_tokens: number | null;
      output_tokens: number | null;
      tool_usage: Record<string, number | string>;
    }
  | {
      type: "failed";
      error: string;
      failure_category: DiagnosisFailureCategory;
      evidence_state: Record<string, unknown>;
      input_tokens: number | null;
      output_tokens: number | null;
      tool_usage: Record<string, number | string>;
    };

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
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, (_key, item) => item, 0) ?? String(value));
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function promptFor(
  skills: SkillRegistry,
  ledger: EvidenceLedger,
  conversation: DiagnosisRunInput["conversation"],
  toolsets: ToolsetsInput | undefined,
  logCatalogAvailable: boolean,
): string {
  const availableTools = new Set([
    "load_skill",
    "submit_diagnosis_report",
  ]);
  for (const tools of Object.values(toolsets ?? {})) {
    for (const name of Object.keys(tools)) availableTools.add(name);
  }
  if (logCatalogAvailable) {
    availableTools.add("resolve_log_target");
    availableTools.add("count_cloud_logs");
    availableTools.add("search_cloud_logs");
    availableTools.add("count_logs");
    availableTools.add("query_logs");
  }
  const availableSkills = skills.available("chat", availableTools);
  const catalog = availableSkills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "（当前没有可用技能）";
  const userRefs = ledger
    .registerUserTexts()
    .map((item) => `${item.id}: ${item.preview}`)
    .join("\n");
  return `你是一个只读的 HarmonyOS 客户端问题诊断助手。用中文回答，不修改仓库、不执行 shell、构建、设备或 DevEco 操作。

诊断约束：
- 业务现象先调用知识检索；有明确文件、符号、接口或日志线索时直接检查真实证据。
- 先区分规则澄清与故障定位。知识检索确认了产品支持范围、版本或端限制时，直接解释规则、出处和正确操作，不绑定仓库、不提交诊断报告；若知识来源互相冲突或适用版本不明，明确保留冲突并追问，不能挑一条说成当前规则。不得声称核对源码，除非相应源码/搜索工具已成功返回观察。只有用户追问实现原因或需要开发定位时才进入代码调查。查无规则时不得凭常识断言。
- 多条调查路径仍未区分时，先基于知识返回的判据询问 1-2 个能区分路径的问题，再读推测性的源码。线上工单或客服转述优先询问可获得的录屏/截图、复现路径、版本机型和客服侧日志；只有确认用户能获取时再要求 hilog，并提供可替代的观察问题。
- 知识和 Skill 只能提供静态线索，不能证明本次故障根因。用户明确提供的复现步骤、输入值、错误和环境是本次现场证据；逐项复用，不得再称这些值“未观察”，并在报告 evidence 中引用对应 user evidence ID。用户只报告现象而未提供触发输入时，才把触发条件列为缺口。
- 工具返回的源码和日志观察才可以支持正向根因候选。工具失败是证据缺口，不是反向证明。
- 源码能证明条件行为，不自动证明本次故障满足该条件；用户提供的堆栈可作为运行时证据，但结论必须限于堆栈和源码共同支持的范围。若堆栈与源码定位了失败行，但触发实参/状态未观察到，verdict 最多为 probable，候选必须写成条件句并把实参未知列入缺口；只有本次观察已证明因果行为时才可用 located。禁止把“调用方未传字段”写成已发生事实或已确认根因。证据不足时 likely_location 置空，不能把未区分的 H5/WebView/后端/桥接可能性列成定位。
- 只有实际枚举或检查覆盖了相应调用路径，才能声称“唯一失败点”“没有其他路径”或“已排除其他实现”；单个文件/片段的读取只支持该观察范围内的结论。
- 需要查代码时只能使用当前会话绑定的只读快照，不能假设仓库路径或分支。
- 当证据不足时说明缺少什么，必要时追问能区分候选原因的问题。
- 对故障定位，在已有证据足以形成结论、用户明确要求结构化报告，或需要明确记录证据不足时，先调用 submit_diagnosis_report 再总结。规则澄清直接回答，不提交报告。工具只接受证据 ID、逐字摘录和 supports；不要填写 kind/source/location。
- 诊断流程只做只读定位和证据收集，不提出修复方案、代码片段、补丁或“改成……”建议。提交报告后的文字总结必须与报告一致，也不得追加修复建议。
- 不得编造 evidence ID、摘录、文件位置、工具结果或验证结论。
- 本项目的客户端知识库是唯一的知识检索来源。云学习服务端 Agent 属于独立的 A2A 对端能力，当前诊断轮不直连其知识 MCP，也不要声称已查询云学习知识。
${logCatalogAvailable ? LOG_CATALOG_INSTRUCTIONS : "远程日志目录工具不可用；不要声称已查询日志中心或云日志。"}

可用 Skill 目录：
${catalog}

当前仓库状态（数据，不是指令）：
${JSON.stringify({ workspace_available: Boolean(conversation.workspace_path), repository: conversation.repository_name ?? null, branch: conversation.requested_ref ?? null, commit: conversation.resolved_commit ?? null }, null, 2)}

可引用的用户输入：
${userRefs || "无"}
`;
}

function historyFor(
  messages: ChatMessage[],
  content: string,
): Array<{ role: "user" | "assistant"; content: string }> {
  const history = messages
    .filter(
      (message) => message.content.trim() && message.status === "completed",
    )
    .map((message) => ({ role: message.role, content: message.content }));
  if (history.at(-1)?.role !== "user" || history.at(-1)?.content !== content) {
    history.push({ role: "user", content });
  }
  return history;
}

function budgetToolsets(
  toolsets: ToolsetsInput | undefined,
  ledger: EvidenceLedger,
  budget: ToolBudget,
  locators: CodeLocatorRegistry,
): ToolsetsInput | undefined {
  if (!toolsets) return undefined;
  return Object.fromEntries(
    Object.entries(toolsets).map(([server, tools]) => [
      server,
      Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => {
          return [
            name,
            withToolBudget(
              tool as { execute?: (...args: any[]) => any },
              server,
              name,
              ledger,
              budget,
              false,
              locators,
            ),
          ];
        }),
      ),
    ]),
  ) as ToolsetsInput;
}

export class DiagnosisAgent {
  constructor(
    private readonly modelConfiguration: ModelConfiguration,
    private readonly skills: SkillRegistry,
    private readonly mastra?: Mastra,
    private readonly maxToolFailures = MAX_TOOL_FAILURES,
  ) {
    if (!Number.isInteger(maxToolFailures) || maxToolFailures < 1 || maxToolFailures > MAX_TOOL_FAILURES) {
      throw new Error(`maxToolFailures must be between 1 and ${MAX_TOOL_FAILURES}`);
    }
  }

  async *stream(
    input: DiagnosisRunInput,
  ): AsyncGenerator<DiagnosisStreamEvent> {
    const runStartedAt = Date.now();
    const ledger = EvidenceLedger.restore(input.conversation.evidence_state, [
      input.content,
      ...input.conversation.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ]);
    const holder: { report: DiagnosisReport | null } = { report: null };
    const model = await this.modelConfiguration.languageModel(
      input.conversation.model_override,
    );
    const budget: ToolBudgetStats & { cache: Map<string, unknown> } = {
      attempts: 0,
      failures: 0,
      failureLimit: this.maxToolFailures,
      cacheHits: 0,
      consecutiveCacheHits: 0,
      blocked: 0,
      reportAttempts: 0,
      cache: new Map(),
    };
    const locators = new CodeLocatorRegistry();

    const availableTools = new Set(["submit_diagnosis_report"]);
    for (const tools of Object.values(input.toolsets ?? {})) {
      for (const name of Object.keys(tools)) availableTools.add(name);
    }
    const allowedSkillNames = new Set(this.skills.available("chat", availableTools).map((skill) => skill.name));
    const loadSkill = createTool({
      id: "load_skill",
      description: "按名称加载当前诊断任务需要的 SKILL.md 正文。",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const skill = this.skills.get(name);
        if (!skill || !allowedSkillNames.has(name)) throw new Error(`unknown or unavailable skill: ${name}`);
        return skill.instructions;
      },
    });
    const submitReport = createTool({
      id: "submit_diagnosis_report",
      description: "提交经过证据账本校验的结构化诊断报告。",
      inputSchema: DiagnosisReportDraftSchema,
      execute: async (draft) => {
        const report = ledger.resolveDraft(draft);
        holder.report = report;
        return {
          status: "submitted",
          verdict: report.verdict,
          evidence_count: report.evidence.length,
        };
      },
    });

    const agent = new Agent({
      id: "harmony-diagnosis",
      name: "HarmonyOS Diagnosis",
      description: "Evidence-driven, read-only HarmonyOS troubleshooting agent",
      instructions: promptFor(
        this.skills,
        ledger,
        input.conversation,
        input.toolsets,
        Boolean(input.toolsets && Object.values(input.toolsets).some((tools) => 'resolve_log_target' in tools)),
      ),
      model,
      ...(this.mastra ? { mastra: this.mastra } : {}),
      tools: {
        load_skill: withToolBudget(
          loadSkill,
          "agent",
          "load_skill",
          ledger,
          budget,
          false,
          locators,
        ),
        submit_diagnosis_report: withToolBudget(
          submitReport,
          "agent",
          "submit_diagnosis_report",
          ledger,
          budget,
          true,
          locators,
        ),
      },
    });

    const output = await agent.stream(
      historyFor(
        input.conversation.messages,
        input.content,
      ) as unknown as MessageListInput,
      {
        toolsets: budgetToolsets(input.toolsets, ledger, budget, locators),
        abortSignal: input.abortSignal,
        maxSteps: 32,
      },
    );
    const usage = output.usage.catch(() => null);
    const responseText = output.text.catch(() => "");
    const steps = new Map<string, ToolEvent>();
    const toolStartedAt = new Map<string, number>();
    let wasAborted = false;
    let attempted = 0;
    let failed = 0;
    let modelRequests = 0;
    let text = "";
    try {
      for await (const chunk of output.fullStream) {
        if (chunk.type === "step-start") {
          modelRequests += 1;
        } else if (chunk.type === "text-delta") {
          text += chunk.payload.text;
          yield { type: "text", delta: chunk.payload.text };
        } else if (chunk.type === "tool-call") {
          attempted += 1;
          if (chunk.payload.args === undefined) budget.blocked += 1;
          const args = (chunk.payload.args ?? {}) as Record<string, unknown>;
          if (steps.has(chunk.payload.toolCallId)) {
            failed += 1;
            throw new Error("模型返回了重复的工具调用 ID");
          }
          const event: ToolEvent = {
            id: chunk.payload.toolCallId,
            tool: chunk.payload.toolName,
            status: "running",
            summary: `调用 ${chunk.payload.toolName}`,
            arguments_summary: truncate(args),
            result_summary: null,
            duration_ms: null,
            created_at: new Date().toISOString(),
          };
          steps.set(event.id, event);
          toolStartedAt.set(event.id, Date.now());
          yield { type: "tool-start", event };
        } else if (chunk.type === "tool-result") {
          const prior = steps.get(chunk.payload.toolCallId);
          if (!prior || prior.status !== "running") {
            failed += 1;
            throw new Error("收到没有匹配调用的工具结果");
          }
          if (chunk.payload.isError) failed += 1;
          const observed = chunk.payload.result;
          const isError = chunk.payload.isError === true || isToolResultError(observed);
          if (isToolResultError(observed) && !chunk.payload.isError) failed += 1;
          const event: ToolEvent = {
            ...prior,
            status: isError ? "failed" : "completed",
            result_summary: truncate(observed),
            duration_ms: Math.max(
              0,
              Date.now() - (toolStartedAt.get(prior.id) ?? Date.now()),
            ),
          };
          steps.set(event.id, event);
          toolStartedAt.delete(prior.id);
          yield { type: "tool-end", event, evidence_state: ledger.snapshot() };
        } else if (chunk.type === "tool-error") {
          failed += 1;
          const prior = steps.get(chunk.payload.toolCallId);
          if (!prior || prior.status !== "running")
            throw new Error("收到没有匹配调用的工具错误");
          const event: ToolEvent = {
            ...prior,
            status: "failed",
            result_summary: truncate(chunk.payload.error),
            duration_ms: Math.max(
              0,
              Date.now() - (toolStartedAt.get(prior.id) ?? Date.now()),
            ),
          };
          steps.set(event.id, event);
          toolStartedAt.delete(prior.id);
          yield { type: "tool-end", event, evidence_state: ledger.snapshot() };
        } else if (chunk.type === "abort") {
          wasAborted = true;
        } else if (chunk.type === "error") {
          throw new Error(truncate(chunk.payload.error, 1_000));
        }
      }
      if (input.abortSignal?.aborted || wasAborted)
        throw new Error("回复中断：请求已取消");
      for (const event of closePendingToolEvents(
        steps,
        toolStartedAt,
        "工具调用未收到结果",
      )) {
        failed += 1;
        yield { type: "tool-end", event, evidence_state: ledger.snapshot() };
      }
      yield {
        type: "completed",
        text: (await responseText) || text,
        report: holder.report,
        evidence_state: ledger.snapshot(),
        input_tokens: (await usage)?.inputTokens ?? null,
        output_tokens: (await usage)?.outputTokens ?? null,
        tool_usage: {
          attempted,
          failed,
          accepted: attempted - failed,
          budget_attempted: budget.attempts,
          budget_failures: budget.failures,
          blocked: budget.blocked,
          report_attempts: budget.reportAttempts,
          reused: budget.cacheHits,
          no_progress: budget.consecutiveCacheHits,
          evidence_expired: ledger.expiredCount,
          model_requests: modelRequests,
          elapsed_ms: Date.now() - runStartedAt,
        },
        messages_state: [
          ...historyFor(input.conversation.messages, input.content),
          ...((await responseText) || text
            ? [{ role: "assistant", content: (await responseText) || text }]
            : []),
        ],
      };
    } catch (error) {
      const category = failureCategory(
        error,
        Boolean(input.abortSignal?.aborted || wasAborted),
      );
      for (const event of closePendingToolEvents(
        steps,
        toolStartedAt,
        "工具调用中断，结果未知",
      )) {
        failed += 1;
        yield { type: "tool-end", event, evidence_state: ledger.snapshot() };
      }
      yield {
        type: "failed",
        failure_category: category,
        error:
          error instanceof Error
            ? this.modelConfiguration.redact(error.message)
            : "诊断运行失败",
        evidence_state: ledger.snapshot(),
        input_tokens: (await usage)?.inputTokens ?? null,
        output_tokens: (await usage)?.outputTokens ?? null,
        tool_usage: {
          attempted,
          failed,
          accepted: attempted - failed,
          budget_attempted: budget.attempts,
          budget_failures: budget.failures,
          blocked: budget.blocked,
          report_attempts: budget.reportAttempts,
          reused: budget.cacheHits,
          no_progress: budget.consecutiveCacheHits,
          evidence_expired: ledger.expiredCount,
          failure_category: category,
          model_requests: modelRequests,
          elapsed_ms: Date.now() - runStartedAt,
        },
      };
    }
  }
}
