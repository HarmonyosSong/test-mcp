import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { closePendingToolEvents, DiagnosisAgent } from '../src/diagnosis/agent.js';
import type { DiagnosisRunInput, DiagnosisStreamEvent } from '../src/diagnosis/agent.js';
import { ObservationRegistry } from '../src/diagnosis/observations.js';
import { SkillRegistry } from '../src/diagnosis/skills.js';
import { ModelConfiguration } from '../src/model/configuration.js';

/**
 * 单 loop 诊断轮次回归（去编排化后替代 legacy-diagnosis-regression）。
 *
 * 与旧套件的核心差异：不再有 submit_diagnosis_report / 阶段 / 门禁；
 * 模型自主决定工具路径，最终回答经 FinalAnswerValidator 校验（判定锚点 + ev-ID 存在性）后放出。
 * 仍沿用 legacy fixture 的五个场景，保证行为连续性可对照。
 */

type Turn =
  | { text: string }
  | { tool: string; args: Record<string, unknown>; id?: string; finishReason?: 'tool-calls' | 'stop' };

type LegacyDiagnosisCase = {
  id?: string;
  scenario?: string;
  title: string;
  description: string;
  evidence: string;
  expected_verdict: string;
  knowledge_entry?: string;
  question?: string;
  answer?: string;
  narrowed_scope?: string;
  followup?: string;
  tool_calls?: string[];
  expected_executed?: string[];
  expected_tool_statuses?: string[];
  failure_limit?: number;
};

const legacyCases = readFileSync(new URL('./fixtures/legacy-diagnosis-cases.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LegacyDiagnosisCase);

function legacyCase(selector: (item: LegacyDiagnosisCase) => boolean): LegacyDiagnosisCase {
  const item = legacyCases.find(selector);
  assert.ok(item, 'expected legacy diagnosis fixture');
  return item;
}

assert.equal(legacyCases.length, 5, 'legacy diagnosis fixture row count changed');

const VERDICT_TEXT: Record<string, string> = {
  located: '已定位',
  probable: '可能定位',
  insufficient_evidence: '证据不足',
  tool_error: '工具异常',
};

/** 给脚本化的最终回答补上判定锚点（模拟遵循输出规范的模型）。 */
function anchored(verdict: string, body: string): string {
  return `判定：${VERDICT_TEXT[verdict] ?? verdict}\n${body}`;
}

function modelFor(turns: Turn[]) {
  let index = 0;
  const prompts: unknown[] = [];
  const model = new MastraLanguageModelV2Mock({
    doStream: async (call) => {
      prompts.push(call.prompt);
      const turn = turns[index++];
      if (!turn) throw new Error('scripted model ran out of responses');
      const chunks: any[] = [{ type: 'stream-start', warnings: [] }];
      if ('tool' in turn) {
        chunks.push({
          type: 'tool-call',
          toolCallId: turn.id ?? `call-${index}`,
          toolName: turn.tool,
          input: JSON.stringify(turn.args),
        });
      } else {
        chunks.push({ type: 'text-start', id: `text-${index}` });
        chunks.push({ type: 'text-delta', id: `text-${index}`, delta: turn.text });
        chunks.push({ type: 'text-end', id: `text-${index}` });
      }
      chunks.push({
        type: 'finish',
        finishReason: 'tool' in turn ? turn.finishReason ?? 'tool-calls' : 'stop',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  });
  return { model, consumed: () => index, prompts };
}

async function setup(
  turns: Turn[],
  maxToolFailures?: number,
  historyBudgetChars?: number,
  contextEviction?: {
    enabled: boolean;
    budgetTokens?: number;
    targetTokens?: number;
    keepRecentResults?: number;
    minEvictChars?: number;
    clampChars?: number;
    offloadDir: string;
    summarize?: (input: { system: string; user: string; maxOutputTokens: number }) => Promise<string>;
  },
  codeIndexWindowSummary?: string,
) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const skills = new SkillRegistry(resolve(projectRoot, 'skills'));
  await skills.load();
  const configuration = new ModelConfiguration({ filePath: '/tmp/unused-mastra-test-model.json', env: {} });
  const scripted = modelFor(turns);
  Object.defineProperty(configuration, 'languageModel', { value: async () => scripted.model });
  const diagnosis = new DiagnosisAgent(configuration, skills, new Mastra({ logger: false }), maxToolFailures, historyBudgetChars, contextEviction, codeIndexWindowSummary);
  return { diagnosis, scripted };
}

async function run(
  diagnosis: DiagnosisAgent,
  content: string,
  options: {
    conversation?: Partial<DiagnosisRunInput['conversation']>;
    toolsets?: DiagnosisRunInput['toolsets'];
    softDeadlineAt?: number | null;
  } = {},
): Promise<DiagnosisStreamEvent[]> {
  const events: DiagnosisStreamEvent[] = [];
  for await (const event of diagnosis.stream({
    conversation: { id: 'single-loop-regression', messages: [], evidence_state: {}, ...options.conversation },
    content,
    toolsets: options.toolsets,
    softDeadlineAt: options.softDeadlineAt,
  })) events.push(event);
  return events;
}

test('unmatched tool calls close as failed once with unknown result semantics', () => {
  const event = {
    id: 'call-pending',
    tool: 'read_project_file',
    status: 'running',
    summary: '调用 read_project_file',
    arguments_summary: null,
    result_summary: null,
    duration_ms: null,
    created_at: new Date(0).toISOString(),
  };
  const steps = new Map([[event.id, event]]);
  const startedAt = new Map([[event.id, 100]]);
  const closed = closePendingToolEvents(steps, startedAt, '工具调用未收到结果', 150);

  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.status, 'failed');
  assert.equal(closed[0]?.summary, '工具调用未收到结果');
  assert.equal(closed[0]?.result_summary, '工具结果未知');
  assert.equal(closed[0]?.duration_ms, 50);
  assert.equal(startedAt.has(event.id), false);
  assert.deepEqual(closePendingToolEvents(steps, startedAt, '重复关闭', 200), []);
});

test('duplicate provider tool-call IDs fail without duplicating or mispairing events', async () => {
  const duplicate = { tool: 'load_skill', args: { name: 'locate-app-issue' }, id: 'provider-duplicate-id' } as const;
  const { diagnosis } = await setup([duplicate, duplicate]);
  const events = await run(diagnosis, '检查登录页白屏');
  const starts = events.filter((event) => event.type === 'tool-start');
  const ends = events.filter((event) => event.type === 'tool-end');
  const terminal = events.at(-1);

  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0]?.type === 'tool-start' ? starts[0].event.id : null, 'provider-duplicate-id');
  assert.equal(ends[0]?.type === 'tool-end' ? ends[0].event.id : null, 'provider-duplicate-id');
  assert.equal(terminal?.type, 'failed');
  if (terminal?.type === 'failed') assert.equal(terminal.failure_category, 'tool_protocol_error');
});

test('知识问答不绑源码：规则命中后直接给出含判定锚点的回答', async () => {
  const sample = legacyCase((item) => item.title === '登录有问题');
  const { diagnosis, scripted } = await setup([
    { tool: 'lookup_issue', args: { query: '入口没有显示' } },
    { text: anchored('located', '该入口仅对符合条件的课程开放；请检查课程类型和当前版本。') },
  ]);
  const lookup = createTool({
    id: 'lookup_issue',
    description: 'Look up a product support rule.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ matches: [{ name: 'feature-availability', text: '此功能仅对特定课程开放。' }] }),
  });
  const events = await run(diagnosis, '为什么我的课程没有这个入口？', {
    toolsets: { knowledge: { lookup_issue: lookup } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  // 结构化报告已退役：report 恒为 null，判定来自文本锚点。
  assert.equal(completed.report, null);
  assert.equal(completed.verdict, 'located');
  assert.match(completed.text, /仅对符合条件的课程开放/);
  assert.match(completed.text, /^判定：已定位/);
  // 知识结果不是观测：注册表保持为空。
  assert.equal((completed.evidence_state.entries as unknown[] | undefined)?.length ?? 0, 0);
  assert.equal(typeof completed.tool_usage.model_requests, 'number');
  assert.ok(Number(completed.tool_usage.model_requests) >= 1);
  const prompt = JSON.stringify(scripted.prompts[0]);
  assert.match(prompt, /学而思 App 问题总入口/);
  assert.match(prompt, /自主决定排查路径/);
  assert.match(prompt, /判定锚点/);
  void sample;
});

test('incident 全链路：prepare_source 绑定后读码，最终回答引用真实 ev-ID', async () => {
  const sample = legacyCase((item) => item.title === '登录页启动白屏');
  const location = sample.evidence.match(/ at (.+):(\d+)$/);
  assert.ok(location, 'source fixture must include a path and line');
  const [, relativePath, lineText] = location;
  const line = Number(lineText);
  const source = `// fixture lines before observed source\n`.repeat(line - 1) + `throw new TypeError('${sample.evidence.split(':')[0]}')`;
  const sourceIdentity = {
    repository_id: 'repo-fixture',
    resolved_commit: 'a'.repeat(40),
  };
  // 与运行时注册表相同的哈希输入预计算 ev-ID（内容哈希契约，跨进程稳定）。
  const observed = new ObservationRegistry({ sourceContext: sourceIdentity }).capture(
    'read_project_file',
    { relative_path: relativePath },
    { path: relativePath, start_line: line, end_line: line, content: source },
  ) as { evidence_refs: Array<{ id: string }> };
  const id = observed.evidence_refs[0]!.id;

  const { diagnosis } = await setup([
    { tool: 'prepare_source', args: { hint: '学而思 鸿蒙 7.8.0' } },
    { tool: 'read_project_file', args: { relative_path: relativePath } },
    { text: anchored(sample.expected_verdict, `启动白屏源于 ${relativePath}:${line} 访问缺失字段抛出 TypeError（观测 ${id}）。`) },
  ]);
  const prepareSource = createTool({
    id: 'prepare_source',
    description: 'Bind a read-only source snapshot.',
    inputSchema: z.object({ hint: z.string().optional() }),
    execute: async () => ({ status: 'bound', workspace_path: '/fixture', ...sourceIdentity }),
  });
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source from the bound test workspace.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async () => ({ path: relativePath, start_line: line, end_line: line, content: source }),
  });
  const events = await run(diagnosis, sample.description, {
    conversation: {
      workspace_path: '/fixture',
      repository_id: sourceIdentity.repository_id,
      resolved_commit: sourceIdentity.resolved_commit,
    },
    toolsets: { round: { prepare_source: prepareSource }, repository: { read_project_file: read } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.verdict, sample.expected_verdict);
  assert.equal(completed.report, null);
  const entries = completed.evidence_state.entries as Array<{ source: string; source_context?: unknown }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.source, 'mcp:read_project_file');
  assert.deepEqual(entries[0]?.source_context, { ...sourceIdentity, path: relativePath });
  assert.equal(completed.tool_usage.budget_attempted, 2);
});

test('跨端对比：对照端观测携带对照端身份，双端 ev-ID 同场引用通过校验', async () => {
  const path = 'src/crossReport/SucceedListItem';
  const incidentRepos = [{
    repository_id: 'repo-harmony', repository_name: 'xesapp-harmony',
    requested_ref: '7.106.0', resolved_commit: 'a'.repeat(40), role: 'shell' as const, mount_path: '',
  }];
  const compareRepos = [{
    repository_id: 'repo-ios', repository_name: 'xesapp-ios',
    requested_ref: 'xueersi_v7.106.0_1000_20261101', resolved_commit: 'b'.repeat(40), role: 'shell' as const, mount_path: '',
  }];
  const incidentContent = { path, start_line: 44, end_line: 44, content: 'if (kuabaoType === 3 && kuabaoStatus === "4")' };
  const compareContent = { path, start_line: 44, end_line: 44, content: 'if (pendingPayment == 1)' };
  // 与运行时相同的哈希输入预计算双端 ev-ID（target 路由参数不进入哈希）。
  const probe = new ObservationRegistry({ sourceContexts: incidentRepos, compareSourceContexts: () => compareRepos });
  const incidentId = (probe.capture('read_project_file', { relative_path: path }, incidentContent) as {
    evidence_refs: Array<{ id: string }>;
  }).evidence_refs[0]!.id;
  const compareId = (probe.capture('read_project_file', { relative_path: path, target: 'compare' }, compareContent) as {
    evidence_refs: Array<{ id: string }>;
  }).evidence_refs[0]!.id;
  assert.notEqual(incidentId, compareId);

  const { diagnosis } = await setup([
    { tool: 'read_project_file', args: { relative_path: path } },
    { tool: 'read_project_file', args: { relative_path: path, target: 'compare' } },
    { text: anchored('probable', `鸿蒙侧按 kuabaoStatus 判定（观测 ${incidentId}），iOS 侧按 pendingPayment 判定（观测 ${compareId}），两端实现不一致。`) },
  ]);
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source from a bound workspace (incident or compare by target).',
    inputSchema: z.object({ relative_path: z.string(), target: z.string().optional() }),
    execute: async (args) => (args.target === 'compare' ? compareContent : incidentContent),
  });
  const events = await run(diagnosis, '鸿蒙端跨报成功记录不展示去结算按钮', {
    conversation: {
      platform: 'harmony',
      workspace_path: '/fixture/harmony',
      repository_id: 'repo-harmony',
      resolved_commit: 'a'.repeat(40),
      source_repositories: incidentRepos,
      compare_source: {
        platform: 'ios', product_line: 'xueersi', form_factor: null,
        version: '7.106.0', build: null,
        workspace_path: '/fixture/ios',
        repository_id: 'repo-ios', repository_name: 'xesapp-ios',
        requested_ref: 'xueersi_v7.106.0_1000_20261101', resolved_commit: 'b'.repeat(40),
        source_repositories: compareRepos,
        source_completeness: 'partial', source_limitations: [],
        bound_at: new Date(0).toISOString(),
      },
    },
    toolsets: { repository: { read_project_file: read } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.verdict, 'probable');
  const entries = completed.evidence_state.entries as Array<{
    id: string; source_context?: { repository_id: string; resolved_commit: string };
  }>;
  assert.equal(entries.length, 2);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(incidentId)?.source_context?.repository_id, 'repo-harmony');
  assert.equal(byId.get(compareId)?.source_context?.repository_id, 'repo-ios');
  assert.equal(completed.tool_usage.budget_attempted, 2);
});

test('validator 打回重试：无锚点回答不外发，反馈后重答', async () => {
  const { diagnosis, scripted } = await setup([
    { text: '这个入口只对部分课程开放。' },
    { text: anchored('located', '这个入口只对部分课程开放，请确认课程类型。') },
  ]);
  const events = await run(diagnosis, '为什么我的课程没有这个入口？');
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.verdict, 'located');
  assert.match(completed.text, /^判定：已定位/);

  // 文本缓冲：第一次未通过校验的回答从未以 text 事件放出。
  const textEvents = events.filter((event) => event.type === 'text');
  assert.equal(textEvents.length, 1);
  assert.match(textEvents[0]!.type === 'text' ? textEvents[0].delta : '', /判定：已定位/);

  // 校验反馈作为用户消息进入下一轮提示。
  assert.match(JSON.stringify(scripted.prompts[1]), /判定锚点/);
  const roles = completed.messages_state.map((message) => message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
  assert.match(String(completed.messages_state[2]?.content), /判定锚点/);
});

test('校验持续不合格时最后一轮放行，verdict 记 null', async () => {
  const { diagnosis } = await setup([
    { text: '第一次回答，没有锚点。' },
    { text: '第二次回答，仍然没有锚点。' },
    { text: '第三次回答，依旧没有锚点。' },
  ]);
  const events = await run(diagnosis, '登录失败');
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.verdict, null);
  assert.equal(completed.text, '第三次回答，依旧没有锚点。');
  const textEvents = events.filter((event) => event.type === 'text');
  assert.equal(textEvents.length, 1, '只有最终一轮的文本被放出');
  assert.equal(completed.messages_state.length, 6, '两轮打回反馈都留在持久化轨迹里');
});

test('软时限到期：工具关闭返回收尾提示，模型用已有证据收尾', async () => {
  let readCalls = 0;
  const { diagnosis } = await setup([
    { tool: 'read_project_file', args: { relative_path: 'Entry.ets' } },
    { text: anchored('insufficient_evidence', '本轮已到收尾时间，尚未取得源码观测；请提供日志或版本信息后重试。') },
  ]);
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async () => {
      readCalls += 1;
      return { path: 'Entry.ets', start_line: 1, content: 'x' };
    },
  });
  const events = await run(diagnosis, '页面打开失败', {
    toolsets: { repository: { read_project_file: read } },
    softDeadlineAt: Date.now() - 1_000,
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(readCalls, 0, '软时限后底层工具不再真实执行');
  assert.equal(completed.verdict, 'insufficient_evidence');
  assert.equal(completed.tool_usage.soft_closed, 1);
  const ends = events.filter((event) => event.type === 'tool-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.type === 'tool-end' ? ends[0].event.status : null, 'failed');
  assert.match(ends[0]!.type === 'tool-end' ? ends[0].event.result_summary ?? '' : '', /收尾/);
});

test('外部协查预算耗尽：工具如实返回缺口，模型基于已有证据收尾', async () => {
  const { diagnosis, scripted } = await setup([
    { tool: 'consult_compass', args: { question: '请核查排行榜接口实现' } },
    { text: anchored('insufficient_evidence', '本地知识未覆盖该接口，本轮外部协查次数已用完；请补充接口返回示例后再查。') },
  ]);
  const consult = createTool({
    id: 'consult_compass',
    description: 'Delegate to the external full-stack agent.',
    inputSchema: z.object({ question: z.string(), context: z.string().optional() }),
    execute: async () => ({ status: 'budget_exhausted', note: '本轮外部协查次数已用完' }),
  });
  // 真实挂载中 consult_compass 与 request_compass_followup 总是同时存在（web 渠道），
  // 提示词协查段以 followup 可用为锚；单挂 consult 的组合线上不存在。
  const followup = createTool({
    id: 'request_compass_followup',
    description: 'Delegate with async follow-up.',
    inputSchema: z.object({ question: z.string(), context: z.string().optional() }),
    execute: async () => ({ status: 'pending' }),
  });
  const events = await run(diagnosis, '请查询一下英语绘本阅读排行榜的接口', {
    toolsets: { round: { consult_compass: consult, request_compass_followup: followup } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.verdict, 'insufficient_evidence');
  const prompt = JSON.stringify(scripted.prompts[0]);
  assert.match(prompt, /Compass（服务端研发 Agent/);
  assert.match(prompt, /与本地观测同级/);
  assert.doesNotMatch(prompt, /仅来自远端 Agent 报告|本地未验证/);
});

test('协查完成态结论作为正式观测：最终回答可直接引用其 ev-ID 支撑判定', async () => {
  const consultResult = {
    status: 'completed',
    conclusion: '服务端 successRecord 接口在多退少补场景返回 kuabaoStatus=1。',
    consultation_id: 'consult-evidence-fixture',
    truncated: false,
    limitations: [],
  };
  const observed = new ObservationRegistry().capture(
    'consult_compass',
    { question: '请核查 successRecord 接口返回值' },
    consultResult,
  ) as { evidence_refs: Array<{ id: string }> };
  const evidenceId = observed.evidence_refs[0]!.id;
  const { diagnosis } = await setup([
    { tool: 'consult_compass', args: { question: '请核查 successRecord 接口返回值' } },
    { text: anchored('located', `服务端在多退少补场景返回 kuabaoStatus=1，与客户端按钮条件不匹配（观测 ${evidenceId}）。`) },
  ]);
  const consult = createTool({
    id: 'consult_compass',
    description: 'Delegate to the Compass server development agent.',
    inputSchema: z.object({ question: z.string() }),
    execute: async () => consultResult,
  });
  const events = await run(diagnosis, '多退少补场景为什么没有去结算按钮？', {
    toolsets: { round: { consult_compass: consult } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.verdict, 'located');
  const entries = completed.evidence_state.entries as Array<{
    id: string; kind: string; source: string; observation_context?: { consultation_id?: string };
  }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, evidenceId);
  assert.equal(entries[0]?.kind, 'external');
  assert.equal(entries[0]?.source, 'compass:consult_compass');
  assert.equal(entries[0]?.observation_context?.consultation_id, 'consult-evidence-fixture');
});

test('工具事件：不脱敏，uid/电话/凭证均明文保留', async () => {
  const rawQuery = 'uid=student-fixture-001 phone=+8613800000000';
  const { diagnosis } = await setup([
    { tool: 'lookup_issue', args: { query: rawQuery } },
    { text: anchored('located', '已完成查询。') },
  ]);
  const lookup = createTool({
    id: 'lookup_issue',
    description: 'fixture query',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => ({ query, authorization: 'Bearer fixture-secret-token' }),
  });
  const events = await run(diagnosis, '学员编号: student-fixture-001; 联系电话: +8613800000000', {
    toolsets: { knowledge: { lookup_issue: lookup } },
  });
  const serialized = JSON.stringify(events.filter((event) => event.type === 'tool-start' || event.type === 'tool-end'));
  // 2026-11-13 起不脱敏：全链路内网明文，便于跨侧排查。
  assert.equal(serialized.includes('student-fixture-001'), true);
  assert.equal(serialized.includes('+8613800000000'), true);
  assert.equal(serialized.includes('13800000000'), true);
  assert.equal(serialized.includes('fixture-secret-token'), true);
});

test('多轮澄清：问题与回答跨轮保留在提示里', async () => {
  const sample = legacyCase((item) => item.id === 'clarify-entry-without-end');
  const question = sample.question!;
  const answer = sample.answer!;
  const { diagnosis, scripted } = await setup([
    { tool: 'load_skill', args: { name: 'locate-app-issue' } },
    { tool: 'lookup_issue', args: { query: sample.description } },
    { text: anchored('insufficient_evidence', question) },
    { text: anchored('insufficient_evidence', '已收窄到鸿蒙的历史录音回看入口，不是新评测；当前仍缺少实际日志，不能确定根因。') },
  ]);
  const lookup = createTool({
    id: 'lookup_issue',
    description: 'Look up a local symptom entry.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({
      matches: [{ name: 'picturebook-speech-eval-failure', section: '区分它们需要什么', text: '区分新评测和我的作品回看 evaluationCheckView。' }],
    }),
  });
  const toolsets = { knowledge: { lookup_issue: lookup } };
  const first = await run(diagnosis, sample.description, { toolsets });
  const firstFinal = first.at(-1);
  assert.equal(firstFinal?.type, 'completed');
  if (firstFinal?.type !== 'completed') return;
  assert.match(firstFinal.text, /浏览器|入口/);
  assert.equal(firstFinal.verdict, 'insufficient_evidence');

  // 模拟真实跨轮：messages_state 持久化为带 status 的会话消息后进入下一轮。
  const carried = (firstFinal.messages_state as Array<{ role: string; content: string }>)
    .map((message) => ({ ...message, status: 'completed' }));
  const second = await run(diagnosis, answer, {
    conversation: {
      messages: carried as unknown as DiagnosisRunInput['conversation']['messages'],
      evidence_state: firstFinal.evidence_state,
    },
    toolsets,
  });
  const secondFinal = second.at(-1);
  assert.equal(secondFinal?.type, 'completed');
  if (secondFinal?.type === 'completed') {
    assert.match(secondFinal.text, /历史录音回看入口/);
    assert.equal(secondFinal.verdict, 'insufficient_evidence');
  }
  const serializedPrompts = JSON.stringify(scripted.prompts);
  assert.match(serializedPrompts, new RegExp(question.slice(0, 8)));
  assert.match(serializedPrompts, new RegExp(answer.slice(0, 8)));
  assert.match(serializedPrompts, /evaluationCheckView/);
});

test('同签名失败禁原样重试：换路径后继续，最终如实收尾', async () => {
  const sample = legacyCase((item) => item.id === 'one-tool-failure-recover');
  const { diagnosis } = await setup([
    ...sample.tool_calls!.map((relative_path) => ({ tool: 'read_project_file', args: { relative_path } })),
    { text: anchored(sample.expected_verdict, '读取失败后继续检查，但目前证据仍不足。') },
  ]);
  const executed: string[] = [];
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source from the bound test workspace.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async ({ relative_path }) => {
      executed.push(relative_path);
      if (relative_path !== 'present.ets') throw new Error('injected unreadable file');
      return { path: relative_path, start_line: 1, end_line: 1, content: '// no causal evidence' };
    },
  });
  const events = await run(diagnosis, sample.description, { toolsets: { repository: { read_project_file: read } } });
  assert.equal(events.at(-1)?.type, 'completed');
  assert.deepEqual(executed, sample.expected_executed);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool-end').map((event) => event.type === 'tool-end' && event.event.status),
    sample.expected_tool_statuses,
  );
});

test('失败预算耗尽后仍允许收尾回答', async () => {
  const sample = legacyCase((item) => item.id === 'turn-failure-limit');
  const turns = sample.tool_calls!.map((relative_path) => ({ tool: 'read_project_file', args: { relative_path } } as Turn));
  turns.push({ text: anchored(sample.expected_verdict, '连续读取失败，当前证据不足，请提供可访问的源码或日志。') });
  const { diagnosis } = await setup(turns, sample.failure_limit);
  const executed: string[] = [];
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source from the bound test workspace.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async ({ relative_path }) => {
      executed.push(relative_path);
      throw new Error('injected unreadable file');
    },
  });
  const events = await run(diagnosis, sample.description, { toolsets: { repository: { read_project_file: read } } });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.deepEqual(executed, sample.expected_executed);
  const toolEnds = events.filter((event) => event.type === 'tool-end');
  assert.deepEqual(
    toolEnds.map((event) => event.type === 'tool-end' && event.event.status),
    sample.expected_tool_statuses,
  );
  assert.equal(completed.tool_usage.budget_failures, sample.failure_limit);
});

test('skills requiring unavailable tools are omitted and cannot be loaded', async () => {
  const { diagnosis } = await setup([
    { tool: 'load_skill', args: { name: 'removed-manual-repository-binding' } },
    { text: anchored('tool_error', '当前没有仓库绑定工具，因此我不能声称已经绑定。') },
  ]);
  const events = await run(diagnosis, '请检查代码');
  const failedLoad = events.find((event) => event.type === 'tool-end' && event.event.tool === 'load_skill');
  assert.equal(failedLoad?.type === 'tool-end' ? failedLoad.event.status : null, 'failed');
  assert.match(failedLoad?.type === 'tool-end' ? failedLoad.event.result_summary ?? '' : '', /unavailable skill/);
});

test('代码导航约束写入提示：导航只是线索，失败回退文本检索', async () => {
  const { diagnosis, scripted } = await setup([
    { text: anchored('insufficient_evidence', '需要读取命中源码并验证观察范围。') },
  ]);
  const navigationTool = (id: string) => createTool({
    id,
    description: 'Read-only code navigation hint.',
    inputSchema: z.object({}),
    execute: async () => ({}),
  });
  const events = await run(diagnosis, '请定位 refresh 的调用路径。', {
    toolsets: {
      repository: {
        search_code_symbols: navigationTool('search_code_symbols'),
        get_code_outline: navigationTool('get_code_outline'),
        trace_code_path: navigationTool('trace_code_path'),
        read_project_file: navigationTool('read_project_file'),
        search_project_text: navigationTool('search_project_text'),
      },
    },
  });

  assert.equal(events.at(-1)?.type, 'completed');
  const prompt = JSON.stringify(scripted.prompts);
  assert.match(prompt, /不得引用为证据/);
  assert.match(prompt, /read_project_file 核实对应文件内容/);
  assert.match(prompt, /回退到 search_project_text/);
});

test('历史回放按字符预算裁剪：丢弃最早轮次并插入省略说明，当前提问永远保留', async () => {
  const longAnswer = '答'.repeat(10_000);
  const messages = Array.from({ length: 6 }, (_, index) => [
    { role: 'user', content: `第${index}轮问题`, status: 'completed' },
    { role: 'assistant', content: longAnswer, status: 'completed' },
  ]).flat() as unknown as DiagnosisRunInput['conversation']['messages'];
  const { diagnosis, scripted } = await setup(
    [{ text: anchored('located', '本轮结论。') }],
    undefined,
    24_000,
  );
  const events = await run(diagnosis, '当前问题', {
    conversation: { messages },
  });
  assert.equal(events.at(-1)?.type, 'completed');
  const prompt = JSON.stringify(scripted.prompts[0]);
  assert.match(prompt, /已省略/, '裁剪后必须插入省略说明');
  // 裁剪作用于消息历史；系统提示词「可引用的用户输入」清单（40 字符 preview）不受影响，
  // 断言用消息形态（"text":"..."）区分，避免误匹配 ev-user 清单。
  const asMessage = (text: string) => `"text":"${text}"`;
  assert.ok(prompt.includes(asMessage('当前问题')), '当前提问必须保留');
  assert.ok(!prompt.includes(asMessage('第0轮问题')), '最早轮次应从消息历史丢弃');
  assert.ok(!prompt.includes(asMessage('第2轮问题')), '预算外的中间轮次应从消息历史丢弃');
  assert.ok(prompt.includes(asMessage('第5轮问题')), '最新一轮历史必须保留');
});

test('历史总量在预算内时不裁剪、无省略说明', async () => {
  const messages = [
    { role: 'user', content: '第一轮问题', status: 'completed' },
    { role: 'assistant', content: '第一轮回答', status: 'completed' },
  ] as unknown as DiagnosisRunInput['conversation']['messages'];
  const { diagnosis, scripted } = await setup(
    [{ text: anchored('located', '本轮结论。') }],
    undefined,
    24_000,
  );
  const events = await run(diagnosis, '第二轮问题', {
    conversation: { messages },
  });
  assert.equal(events.at(-1)?.type, 'completed');
  const prompt = JSON.stringify(scripted.prompts[0]);
  assert.match(prompt, /第一轮问题/);
  assert.match(prompt, /第一轮回答/);
  assert.doesNotMatch(prompt, /已省略/, '预算内不得插入省略说明');
});

test('上下文超预算时旧工具结果被外置为 ev-file 指针，read_evidence 可取回', async () => {
  const bigPayload = '日志内容'.repeat(1_500); // 每条结果 6000 字符
  const offloadDir = await mkdtemp(join(tmpdir(), 'eviction-it-'));
  try {
    const bigQuery = createTool({
      id: 'big_query',
      description: '测试用大结果查询',
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ q, payload: bigPayload }),
    });
    const { diagnosis, scripted } = await setup(
      [
        { tool: 'big_query', args: { q: 'a' }, id: 'call-a' },
        { tool: 'big_query', args: { q: 'b' }, id: 'call-b' },
        { tool: 'big_query', args: { q: 'c' }, id: 'call-c' },
        { text: anchored('insufficient_evidence', '现有证据不足，建议补充信息。') },
      ],
      undefined,
      undefined,
      {
        enabled: true,
        budgetTokens: 4_000,
        keepRecentResults: 1,
        minEvictChars: 1_000,
        offloadDir,
      },
    );
    const events = await run(diagnosis, '查一下日志', {
      toolsets: { log: { big_query: bigQuery } },
    });
    const completed = events.at(-1);
    assert.equal(completed?.type, 'completed');
    if (completed?.type !== 'completed') return;

    // 后续模型请求的 prompt 里，最早的大结果应已替换为 ev-file 指针。
    const laterPrompts = scripted.prompts.slice(2).map((prompt) => JSON.stringify(prompt)).join('\n');
    assert.match(laterPrompts, /\[ev-file:call-a\]/, '最早的工具结果应被外置');
    assert.ok(!laterPrompts.includes(bigPayload + bigPayload), '外置后原文不应重复出现在后续 prompt');

    // 驱逐统计进入 tool_usage，供回归测量。
    assert.ok(Number(completed.tool_usage.evicted_results) >= 1, 'tool_usage 须记录驱逐次数');
    assert.ok(Number(completed.tool_usage.eviction_passes) >= 1);
  } finally {
    await rm(offloadDir, { recursive: true, force: true });
  }
});

test('持续超目标时旧历史被压成上下文检查点并进入后续 prompt', async () => {
  const bigPayload = '堆栈信息'.repeat(1_500); // 每条结果 6000 字符
  const offloadDir = await mkdtemp(join(tmpdir(), 'eviction-sum-it-'));
  try {
    const bigQuery = createTool({
      id: 'big_query',
      description: '测试用大结果查询',
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ q, payload: bigPayload }),
    });
    const { diagnosis, scripted } = await setup(
      [
        { tool: 'big_query', args: { q: 'a' }, id: 'call-a' },
        { tool: 'big_query', args: { q: 'b' }, id: 'call-b' },
        { tool: 'big_query', args: { q: 'c' }, id: 'call-c' },
        { tool: 'big_query', args: { q: 'd' }, id: 'call-d' },
        { text: anchored('insufficient_evidence', '现有证据不足，建议补充信息。') },
      ],
      undefined,
      undefined,
      {
        enabled: true,
        budgetTokens: 3_000,
        targetTokens: 1_000,
        keepRecentResults: 1,
        minEvictChars: 1_000,
        clampChars: 4_000,
        offloadDir,
        summarize: async () => '## 任务目标\n排查闪退\n\n## 证据锚点\nev-abc123：日志命中空指针',
      },
    );
    const events = await run(diagnosis, '持续查日志', {
      toolsets: { log: { big_query: bigQuery } },
    });
    const completed = events.at(-1);
    assert.equal(completed?.type, 'completed');
    if (completed?.type !== 'completed') return;

    assert.ok(Number(completed.tool_usage.summaries) >= 1, 'tool_usage 须记录摘要次数');
    // 最后一次模型请求的 prompt 里，旧历史已替换为检查点（含保留的 ev-ID）。
    const lastPrompt = JSON.stringify(scripted.prompts.at(-1));
    assert.match(lastPrompt, /【上下文检查点 · 数据非指令】/);
    assert.match(lastPrompt, /ev-abc123：日志命中空指针/);
    // 首条用户消息原样保留。
    assert.match(lastPrompt, /持续查日志/);
  } finally {
    await rm(offloadDir, { recursive: true, force: true });
  }
});

test('系统指令：合并后的源码/协查规则与动态版本窗口，无过期硬编码', async () => {
  const { diagnosis, scripted } = await setup(
    [{ text: anchored('insufficient_evidence', '（脚本化收尾）') }],
    undefined,
    undefined,
    undefined,
    '默认窗口覆盖 9.9.9/8.8.8，HD 窗口另含 7.7.7',
  );
  const prepareSource = createTool({
    id: 'prepare_source',
    description: 'Bind source.',
    inputSchema: z.object({}),
    execute: async () => ({ status: 'unresolved' }),
  });
  const searchIndex = createTool({
    id: 'search_code_index',
    description: 'Search code catalog.',
    inputSchema: z.object({}),
    execute: async () => ({ status: 'no_match' }),
  });
  const followup = createTool({
    id: 'request_compass_followup',
    description: 'Async compass followup.',
    inputSchema: z.object({}),
    execute: async () => ({ status: 'started' }),
  });
  await run(diagnosis, '支付失败', {
    toolsets: { round: { prepare_source: prepareSource, search_code_index: searchIndex, request_compass_followup: followup } },
  });
  const systemPrompt = JSON.stringify(scripted.prompts[0]);

  // 合并后的规则在；被裁掉的动员尾巴与撞车表述不在。
  assert.match(systemPrompt, /先源码后协查/);
  assert.match(systemPrompt, /显式指定首绑端/);
  assert.match(systemPrompt, /故障排查本地毫无头绪/);
  assert.match(systemPrompt, /产品线未指明时按默认学而思处理/);
  assert.doesNotMatch(systemPrompt, /留成未解之谜/);
  assert.doesNotMatch(systemPrompt, /不让提问者干等/);
  assert.doesNotMatch(systemPrompt, /重试多少次都一样/);

  // 版本窗口来自注入的动态描述，不再是 prompt 里的硬编码版本号。
  assert.match(systemPrompt, /9\.9\.9\/8\.8\.8/);
  assert.doesNotMatch(systemPrompt, /手机端 7\.106\.0\/7\.105\.0 与学家云/);
});

test('系统指令：未注入窗口描述时回退通用表述', async () => {
  const { diagnosis, scripted } = await setup([{ text: anchored('insufficient_evidence', '（脚本化收尾）') }]);
  const searchIndex = createTool({
    id: 'search_code_index',
    description: 'Search code catalog.',
    inputSchema: z.object({}),
    execute: async () => ({ status: 'no_match' }),
  });
  await run(diagnosis, '支付失败', { toolsets: { round: { search_code_index: searchIndex } } });
  const systemPrompt = JSON.stringify(scripted.prompts[0]);
  assert.match(systemPrompt, /窗口版本由索引服务端按版本登记表动态维护/);
  assert.doesNotMatch(systemPrompt, /手机端 7\.106\.0/);
});
