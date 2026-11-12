import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { closePendingToolEvents, DiagnosisAgent } from '../src/diagnosis/agent.js';
import type { DiagnosisRunInput } from '../src/diagnosis/agent.js';
import { EvidenceLedger } from '../src/diagnosis/evidence.js';
import { SkillRegistry } from '../src/diagnosis/skills.js';
import { ModelConfiguration } from '../src/model/configuration.js';

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
  const duplicate = { tool: 'load_skill', args: { name: 'locate-harmony-issue' }, id: 'provider-duplicate-id' } as const;
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

async function setup(turns: Turn[], maxToolFailures?: number) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const skills = new SkillRegistry(resolve(projectRoot, 'skills'));
  await skills.load();
  const configuration = new ModelConfiguration({ filePath: '/tmp/unused-mastra-test-model.json', env: {} });
  const scripted = modelFor(turns);
  Object.defineProperty(configuration, 'languageModel', { value: async () => scripted.model });
  const diagnosis = new DiagnosisAgent(configuration, skills, new Mastra({ logger: false }), maxToolFailures);
  return { diagnosis, scripted };
}

async function run(
  diagnosis: DiagnosisAgent,
  content: string,
  options: {
    conversation?: Partial<DiagnosisRunInput['conversation']>;
    toolsets?: DiagnosisRunInput['toolsets'];
    clientSteps?: DiagnosisRunInput['clientSteps'];
  } = {},
) {
  const events = [];
  for await (const event of diagnosis.stream({
    conversation: { id: 'legacy-regression', messages: [], evidence_state: {}, ...options.conversation },
    content,
    toolsets: options.toolsets,
    clientSteps: options.clientSteps,
  })) events.push(event);
  return events;
}

test('legacy evidence-insufficient case submits a report without inventing observations', async () => {
  const sample = legacyCase((item) => item.title === '登录有问题');
  const { diagnosis } = await setup([{
    tool: 'submit_diagnosis_report',
    args: { verdict: 'insufficient_evidence', summary: '描述不足', issue_category: 'unknown', confidence: 0.2, missing_information: ['复现步骤和日志'] },
  }, { text: '目前证据不足，需要复现步骤和日志。' }]);
  const events = await run(diagnosis, sample.description);
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.report?.verdict, sample.expected_verdict);
  assert.equal((completed.evidence_state.entries as unknown[] | undefined)?.length ?? 0, 0);
  assert.equal(typeof completed.tool_usage.model_requests, 'number');
  assert.ok(Number(completed.tool_usage.model_requests) >= 1);
  assert.equal(typeof completed.tool_usage.elapsed_ms, 'number');
  assert.ok(Number(completed.tool_usage.elapsed_ms) >= 0);
});

test('Mastra stream pairs each tool result with the originating call ID', async () => {
  const { diagnosis } = await setup([
    { tool: 'lookup_issue', args: { query: '入口没有显示' } },
    { text: '已读取相关业务知识。' },
  ]);
  const lookup = createTool({
    id: 'lookup_issue',
    description: 'Look up a product support rule.',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => ({ matches: [{ name: 'feature-availability', query }] }),
  });
  const events = await run(diagnosis, '为什么我的课程没有这个入口？', {
    toolsets: { knowledge: { lookup_issue: lookup } },
  });
  const starts = events.filter((event) => event.type === 'tool-start');
  const ends = events.filter((event) => event.type === 'tool-end');
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.event.id, starts[0]!.event.id);
  assert.equal(ends[0]!.event.status, 'completed');
});

test('本地知识未命中时可提交实现查询的外部协查报告，主 Agent 不再限定为鸿蒙或云学习', async () => {
  const { diagnosis, scripted } = await setup([
    { tool: 'lookup_issue', args: { query: '英语绘本阅读排行榜接口' } },
    {
      tool: 'submit_diagnosis_report',
      args: {
        verdict: 'insufficient_evidence',
        summary: '本地知识未覆盖该接口实现，需要统一外部全栈 Agent 协查',
        issue_category: 'interface',
        task_type: 'implementation',
        confidence: 0.2,
        responsibility: 'unknown',
        next_action: { target: 'external', question: '请核查英语绘本阅读排行榜的前端、H5 与服务端接口实现' },
        missing_information: ['接口实现与返回示例'],
        evidence: [],
      },
    },
    { text: '本地知识未覆盖该实现，需要进一步外部协查。' },
  ]);
  const lookup = createTool({
    id: 'lookup_issue',
    description: 'Look up a project implementation clue.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ hits: [] }),
  });
  const events = await run(diagnosis, '请查询一下英语绘本阅读排行榜的接口', {
    toolsets: { knowledge: { lookup_issue: lookup } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.report?.task_type, 'implementation');
  assert.equal(completed.report?.responsibility, 'unknown');
  assert.equal(completed.report?.next_action?.target, 'external');
  const prompts = JSON.stringify(scripted.prompts);
  assert.match(prompts, /培优问题排查助手的主 Agent/);
  assert.match(prompts, /统一外部全栈 Agent/);
  assert.match(prompts, /前端、H5 和服务端/);
  assert.doesNotMatch(prompts, /云学习服务端 Agent/);
});

test('工具事件不会持久化模型复述的原始学员标识', async () => {
  const rawQuery = 'uid=student-fixture-001 phone=+8613800000000';
  const { diagnosis } = await setup([
    { tool: 'lookup_issue', args: { query: rawQuery } },
    { text: '已完成查询。' },
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
  assert.equal(serialized.includes('student-fixture-001'), false);
  assert.equal(serialized.includes('+8613800000000'), false);
  assert.equal(serialized.includes('13800000000'), false);
  assert.equal(serialized.includes('fixture-secret-token'), false);
  assert.match(serialized, /learner_id:[a-f0-9]{16}/);
});

test('invalid report tool input is paired as failed and a corrected report can complete', async () => {
  const { diagnosis } = await setup([
    { tool: 'submit_diagnosis_report', args: { verdict: 'not-a-verdict', confidence: 2 } },
    {
      tool: 'submit_diagnosis_report',
      args: {
        verdict: 'insufficient_evidence',
        summary: '当前证据不足',
        issue_category: 'unknown',
        confidence: 0.2,
        missing_information: ['复现步骤'],
      },
    },
    { text: '请补充复现步骤后继续排查。' },
  ]);

  const events = await run(diagnosis, '登录失败，暂时没有日志');
  const toolStarts = events.filter((event) => event.type === 'tool-start');
  const toolEnds = events.filter((event) => event.type === 'tool-end');
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  assert.equal(toolStarts.length, 2);
  assert.equal(toolEnds.length, 2);
  assert.equal(toolEnds[0]!.event.status, 'failed', JSON.stringify(toolEnds));
  assert.equal(toolEnds[1]!.event.status, 'completed');
  assert.equal(toolEnds[0]!.event.id, toolStarts[0]!.event.id);
  assert.equal(toolEnds[1]!.event.id, toolStarts[1]!.event.id);
  if (completed?.type === 'completed') {
    assert.equal(completed.report?.verdict, 'insufficient_evidence');
    assert.equal(completed.tool_usage.failed, 1);
  }
});

test('reports expired evidence citations in per-turn tool usage metrics', async () => {
  const { diagnosis } = await setup([
    {
      tool: 'submit_diagnosis_report',
      args: {
        verdict: 'probable',
        summary: '引用旧观测',
        issue_category: 'runtime',
        confidence: 0.7,
        evidence: [{ id: 'ev-old', excerpt: 'old source line', supports: '候选原因' }],
        root_cause_candidates: [{ title: '候选原因', explanation: '来自旧观测', confidence: 0.7, evidence_ids: ['ev-old'] }],
      },
    },
    {
      tool: 'submit_diagnosis_report',
      args: {
        verdict: 'insufficient_evidence',
        summary: '旧观测已过期，当前证据不足',
        issue_category: 'unknown',
        confidence: 0.2,
        missing_information: ['请重新读取相关源码或提供日志'],
      },
    },
    { text: '旧证据已过期，当前不能确认根因。' },
  ]);
  const events = await run(diagnosis, '继续检查这个问题', {
    conversation: {
      evidence_state: {
        entries: [],
        texts: {},
        evicted: { 'ev-old': 'Entry.ets:42' },
        ledger_version: 2,
      },
    },
  });
  const failedReport = events.find((event: any) => event.type === 'tool-end' && event.event.tool === 'submit_diagnosis_report');
  const completed = events.at(-1);
  assert.equal(failedReport?.type, 'tool-end');
  if (failedReport?.type === 'tool-end') {
    assert.equal(failedReport.event.status, 'failed');
    assert.match(failedReport.event.result_summary ?? '', /evidence_expired/);
  }
  assert.equal(completed?.type, 'completed');
  if (completed?.type === 'completed') {
    assert.equal(completed.report?.verdict, 'insufficient_evidence');
    assert.equal(completed.tool_usage.evidence_expired, 1);
  }
});

test('a confirmed product-rule clarification answers directly without forcing a diagnosis report', async () => {
  const { diagnosis, scripted } = await setup([
    { tool: 'lookup_issue', args: { query: '入口没有显示' } },
    { text: '该入口仅对符合条件的课程开放；请检查课程类型和当前版本。' },
  ]);
  const lookup = createTool({
    id: 'lookup_issue',
    description: 'Look up a product support rule.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ matches: [{ name: 'feature-availability', text: '此功能仅对特定课程开放。' }] }),
  });
  const events = await run(diagnosis, '为什么我的课程没有这个入口？', { toolsets: { knowledge: { lookup_issue: lookup } } });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.report, null);
  assert.match(completed.text, /仅对符合条件的课程开放/);
  assert.match(JSON.stringify(scripted.prompts), /只有规则解答不需要外部实现调查时才直接结束/);
  assert.equal(events.some((event: any) => event.type === 'tool-start' && event.event.tool === 'submit_diagnosis_report'), false);
});

test('code navigation prompt requires source reads and text-search fallback', async () => {
  const { diagnosis, scripted } = await setup([
    { text: '需要读取命中源码并验证观察范围。' },
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
  assert.match(prompt, /不得引用为 evidence/);
  assert.match(prompt, /read_project_file 核实对应文件内容/);
  assert.match(prompt, /不能据此排除符号、文件或调用路径/);
  assert.match(prompt, /回退到 search_project_text/);
});

test('navigation stays behind observation gate and a failed trace can fall back to source evidence', async () => {
  const { diagnosis } = await setup([
    { tool: 'search_code_symbols', args: { query: 'refresh' } },
    { tool: 'resolve_log_target', args: { query: '页面打开失败' } },
    { tool: 'search_code_symbols', args: { query: 'refresh' } },
    { tool: 'get_code_outline', args: { relative_path: 'src/Page.ets' } },
    { tool: 'trace_code_path', args: { function_name: 'refresh' } },
    { tool: 'search_project_text', args: { query: 'refresh' } },
    { tool: 'read_project_file', args: { relative_path: 'src/Page.ets' } },
    { text: '已读取源码；调用路径和现场平台仍需补充验证。' },
  ]);
  const source = { path: 'src/Page.ets', start_line: 1, content: 'refresh() { return this.value; }' };
  let searches = 0;
  const repository = {
    search_code_symbols: createTool({
      id: 'search_code_symbols', description: 'Find symbols.',
      inputSchema: z.object({ query: z.string(), file_pattern: z.string().default('**/*'), limit: z.number().default(20) }),
      execute: async () => { searches += 1; return { ...source, navigation: { rows: [['refresh', 'src/Page.ets']] } }; },
    }),
    get_code_outline: createTool({
      id: 'get_code_outline', description: 'Outline file.',
      inputSchema: z.object({ relative_path: z.string(), limit: z.number().default(100) }),
      execute: async () => ({ ...source, navigation: { rows: [['refresh']] } }),
    }),
    trace_code_path: createTool({
      id: 'trace_code_path', description: 'Trace static callers.',
      inputSchema: z.object({ function_name: z.string(), direction: z.string().default('inbound'), depth: z.number().default(1), limit: z.number().default(20) }),
      execute: async () => ({ isError: true, content: [{ type: 'text', text: 'code index unavailable' }] }),
    }),
    search_project_text: createTool({
      id: 'search_project_text', description: 'Search source.', inputSchema: z.object({ query: z.string() }),
      execute: async () => ({ matches: [{ ...source, line: 1 }] }),
    }),
    read_project_file: createTool({
      id: 'read_project_file', description: 'Read source.', inputSchema: z.object({ relative_path: z.string() }),
      execute: async () => source,
    }),
  };
  const logs = {
    resolve_log_target: createTool({
      id: 'resolve_log_target', description: 'Resolve log target.', inputSchema: z.object({ query: z.string() }),
      execute: async () => ({ status: 'not_found', candidates: [] }),
    }),
    search_cloud_logs: createTool({
      id: 'search_cloud_logs', description: 'Query logs.', inputSchema: z.object({}), execute: async () => ({}),
    }),
  };
  const events = await run(diagnosis, '请定位 refresh 调用失败。', {
    toolsets: { repository, logs }, clientSteps: ['observe', 'source'],
  });
  const ends = events.filter((event) => event.type === 'tool-end');
  assert.deepEqual(ends.map(({ event }) => event.status), [
    'failed', 'completed', 'completed', 'completed', 'failed', 'completed', 'completed',
  ]);
  assert.equal(searches, 1);
  assert.match(ends[0]!.event.result_summary ?? '', /client_observation_required/);
  for (const end of ends.slice(0, 5)) assert.equal((end.evidence_state.entries as unknown[]).length, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'completed');
  if (terminal?.type !== 'completed') return;
  const evidence = terminal.evidence_state.entries as Array<{ source: string }>;
  assert.deepEqual(evidence.map(({ source }) => source), ['mcp:search_project_text', 'mcp:read_project_file']);
  assert.equal(terminal.tool_usage.budget_attempted, 6);
  assert.equal(terminal.tool_usage.budget_failures, 1);
});

test('skills requiring unavailable tools are omitted and cannot be loaded', async () => {
  const { diagnosis } = await setup([
    { tool: 'load_skill', args: { name: 'removed-manual-repository-binding' } },
    { text: '当前没有仓库绑定工具，因此我不能声称已经绑定。' },
  ]);
  const events = await run(diagnosis, '请检查代码');
  const failedLoad = events.find((event: any) => event.type === 'tool-end' && event.event.tool === 'load_skill');
  assert.equal((failedLoad as any)?.event.status, 'failed');
  assert.match((failedLoad as any)?.event.result_summary, /unavailable skill/);
});

test('observe→source 门禁在目录不覆盖后允许重试同一源码调用', async () => {
  const { diagnosis } = await setup([
    { tool: 'read_project_file', args: { relative_path: 'Entry.ets' } },
    { tool: 'resolve_log_target', args: { query: '页面打开失败' } },
    { tool: 'read_project_file', args: { relative_path: 'Entry.ets' } },
    { text: '日志目录未覆盖，源码观察不代表平台已确认。' },
  ]);
  let sourceReads = 0;
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async () => {
      sourceReads += 1;
      return { path: 'Entry.ets', start_line: 1, end_line: 1, content: 'const value = 1;' };
    },
  });
  const resolve = createTool({
    id: 'resolve_log_target',
    description: 'Resolve log target.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ status: 'not_found', candidates: [] }),
  });
  const events = await run(diagnosis, '页面打开失败', {
    conversation: { workspace_path: '/fixture' },
    clientSteps: ['observe', 'source'],
    toolsets: { repository: { read_project_file: read }, log_catalog: { resolve_log_target: resolve, search_cloud_logs: createTool({
      id: 'search_cloud_logs', description: 'Search logs.', inputSchema: z.object({}), execute: async () => ({ logs: [] }),
    }) } },
  });
  const ends = events.filter((event: any) => event.type === 'tool-end') as Array<any>;
  assert.deepEqual(ends.map((event) => [event.event.tool, event.event.status]), [
    ['read_project_file', 'failed'],
    ['resolve_log_target', 'completed'],
    ['read_project_file', 'completed'],
  ]);
  assert.match(ends[0].event.result_summary, /client_observation_required/);
  assert.equal(sourceReads, 1);
  assert.equal(events.at(-1)?.type, 'completed');
});

test('legacy source-location case records a real observation before submitting a positive report', async () => {
  const sample = legacyCase((item) => item.title === '登录页启动白屏');
  const location = sample.evidence.match(/ at (.+):(\d+)$/);
  assert.ok(location, 'source fixture must include a path and line');
  const [, relativePath, lineText] = location;
  const line = Number(lineText);
  const source = `// fixture lines before observed source\n`.repeat(line - 1) + `throw new TypeError('${sample.evidence.split(':')[0]}')`;
  const args = { relative_path: relativePath };
  const sourceIdentity = {
    repository_id: 'repo-fixture',
    resolved_commit: 'a'.repeat(40),
  };
  const observed = new EvidenceLedger({ sourceContext: sourceIdentity }).capture('read_project_file', args, {
    path: relativePath, start_line: line, end_line: line, content: source,
  }) as { evidence_refs: Array<{ id: string }> };
  const id = observed.evidence_refs[0]!.id;
  const { diagnosis } = await setup([
    { tool: 'read_project_file', args: { relative_path: relativePath } },
    { tool: 'submit_diagnosis_report', args: {
      verdict: sample.expected_verdict, summary: '页面访问缺失的 name 时抛出 TypeError', issue_category: 'runtime', likely_location: `${relativePath}:${line}`, confidence: 0.8,
      evidence: [{ id, excerpt: source, supports: '异常来自该源码行' }],
      root_cause_candidates: [{ title: '访问缺失字段', explanation: '此处直接抛出 TypeError', confidence: 0.8, evidence_ids: [id] }],
    } },
    { text: '已定位到页面访问缺失字段的位置。' },
  ]);
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
    toolsets: { repository: { read_project_file: read } },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type !== 'completed') return;
  assert.equal(completed.report?.verdict, sample.expected_verdict);
  assert.equal(completed.report?.evidence[0]?.kind, 'source');
  assert.deepEqual(completed.report?.evidence[0]?.source_context, {
    ...sourceIdentity,
    path: relativePath,
  });
  assert.equal(((completed.evidence_state as { entries: unknown[] }).entries).length, 1);
});

test('legacy tool-failure case retries with a new path and continues after a failed read', async () => {
  const sample = legacyCase((item) => item.id === 'one-tool-failure-recover');
  const { diagnosis } = await setup([
    ...sample.tool_calls!.map((relative_path) => ({ tool: 'read_project_file', args: { relative_path } })),
    { text: '读取失败后继续检查，但目前证据仍不足。' },
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
  assert.deepEqual(events.filter((event: any) => event.type === 'tool-end').map((event: any) => event.event.status), sample.expected_tool_statuses);
});

test('legacy clarification case preserves the question and answer across turns', async () => {
  const sample = legacyCase((item) => item.id === 'clarify-entry-without-end');
  const question = sample.question!;
  const answer = sample.answer!;
  const { diagnosis, scripted } = await setup([
    { tool: 'load_skill', args: { name: 'locate-harmony-issue' } },
    { tool: 'lookup_issue', args: { query: sample.description } },
    { text: question },
    { text: '已收窄到鸿蒙的历史录音回看入口，不是新评测；当前仍缺少实际日志，不能确定根因。' },
  ]);
  const skill = createTool({ id: 'load_skill', description: 'Load one relevant diagnostic skill.', inputSchema: z.object({ name: z.string() }), execute: async () => '入口不清楚时先追问，不能假设根因。' });
  const lookup = createTool({ id: 'lookup_issue', description: 'Look up a local symptom entry.', inputSchema: z.object({ query: z.string() }), execute: async () => ({ matches: [{ name: 'picturebook-speech-eval-failure', section: '区分它们需要什么', text: '区分新评测和我的作品回看 evaluationCheckView。' }] }) });
  const toolsets = { agent: { load_skill: skill }, knowledge: { lookup_issue: lookup } };
  const first = await run(diagnosis, sample.description, { toolsets });
  const firstFinal = first.at(-1);
  assert.equal(firstFinal?.type, 'completed');
  if (firstFinal?.type !== 'completed') return;
  assert.match(firstFinal.text, /浏览器|入口/);
  const second = [];
  for await (const event of diagnosis.stream({
    conversation: {
      id: 'legacy-regression',
      messages: firstFinal.messages_state as any,
      evidence_state: firstFinal.evidence_state,
    },
    content: answer,
    toolsets,
  })) second.push(event);
  assert.equal(second.at(-1)?.type, 'completed');
  const secondFinal = second.at(-1);
  if (secondFinal?.type === 'completed') assert.match(secondFinal.text, /历史录音回看入口/);
  const serializedPrompts = JSON.stringify(scripted.prompts);
  assert.match(serializedPrompts, new RegExp(question.slice(0, 8)));
  assert.match(serializedPrompts, new RegExp(answer.slice(0, 8)));
  assert.match(serializedPrompts, /evaluationCheckView/);
});

test('failure budget exhaustion stops further reads and still allows a terminal response', async () => {
  const sample = legacyCase((item) => item.id === 'turn-failure-limit');
  const turns = sample.tool_calls!.map((relative_path) => ({ tool: 'read_project_file', args: { relative_path } } as Turn));
  turns.push({ text: '连续读取失败，当前证据不足，请提供可访问的源码或日志。' });
  const { diagnosis } = await setup(turns, sample.failure_limit);
  const executed: string[] = [];
  const read = createTool({
    id: 'read_project_file',
    description: 'Read source from the bound test workspace.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async ({ relative_path }) => { executed.push(relative_path); throw new Error('injected unreadable file'); },
  });
  const events = await run(diagnosis, sample.description, { toolsets: { repository: { read_project_file: read } } });
  assert.equal(events.at(-1)?.type, 'completed');
  assert.deepEqual(executed, sample.expected_executed);
  const toolEnds = events.filter((event: any) => event.type === 'tool-end') as Array<{ event: { status: string; result_summary: string | null } }>;
  assert.deepEqual(toolEnds.map((event) => event.event.status), sample.expected_tool_statuses);
});
