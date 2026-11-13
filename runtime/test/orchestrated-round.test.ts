import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';

import type { DiagnosisAgent, DiagnosisRunInput, DiagnosisStreamEvent } from '../src/diagnosis/agent.js';
import { prepareDiagnosisRound, runDiagnosisRound, type OrchestrationEvent } from '../src/diagnosis/run-round.js';
import { DiagnosisReportSchema, type DiagnosisReport } from '../src/domain/schemas.js';
import type { CapabilityMcp } from '../src/capabilities/mcp.js';
import type { ModelConfiguration } from '../src/model/configuration.js';
import { ProductStore } from '../src/product/store.js';
import type { AgentSlotRegistry } from '../src/orchestration/agent-slot-registry.js';
import { createExternalConsultation } from '../src/orchestration/consultation.js';
import {
  createInvestigationStateSnapshot,
  serializeInvestigationState,
} from '../src/orchestration/investigation-state.js';
import type { InvestigationPlan } from '../src/orchestration/plan.js';
import type { ServerSignals } from '../src/orchestration/server-signals.js';

const LOCAL_EVIDENCE_STATE = { entries: [{ id: 'local-source', kind: 'source' }], texts: {} };
const LOCAL_LOG_EVIDENCE_STATE = { entries: [{ id: 'local-log', kind: 'log' }], texts: {} };
const EMPTY_SIGNALS: ServerSignals = { version: 1, serviceNames: [], apiPrefixes: [], errorCodePatterns: [] };
const PARALLEL_SIGNALS: ServerSignals = {
  version: 1,
  serviceNames: ['云学习'],
  apiPrefixes: [],
  errorCodePatterns: ['\\b500\\b'],
};

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  conversationInput: { workspace_path?: string | null; consult_compass?: boolean } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'orchestrated-round-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  try {
    const conversation = await store.createConversation({
      workspace_path: conversationInput.workspace_path ?? '/fixture',
      consult_compass: conversationInput.consult_compass ?? true,
    });
    await run({
      directory,
      store,
      conversation,
      capabilities: {
        createKnowledgeSession: async () => null,
        createRepositorySession: async () => ({ toolsets: {}, client: { disconnect: async () => undefined } }),
      } as unknown as CapabilityMcp,
      modelConfiguration: { enabled: true, redact: (text: string) => text } as unknown as ModelConfiguration,
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

interface Harness {
  directory: string;
  store: ProductStore;
  conversation: Awaited<ReturnType<ProductStore['createConversation']>>;
  capabilities: CapabilityMcp;
  modelConfiguration: ModelConfiguration;
}

function localReport(routing: 'server' | 'client' = 'server'): DiagnosisReport {
  return DiagnosisReportSchema.parse({
    verdict: 'insufficient_evidence',
    summary: '本地源码观测已保存',
    issue_category: 'runtime',
    confidence: 0.4,
    responsibility: routing,
    next_action: routing === 'server'
      ? { target: 'server', question: '模型下一步问题不得进入外发正文' }
      : null,
    missing_information: ['服务端请求结果'],
    evidence: [{
      id: 'local-source',
      kind: 'source',
      source: 'read_project_file',
      location: 'Entry.ets:1',
      excerpt: 'throw new Error("local")',
      supports: '本地源码存在异常路径',
    }],
  });
}

function completedEvent(
  input: DiagnosisRunInput,
  text: string,
  report: DiagnosisReport | null,
  evidence_state = LOCAL_EVIDENCE_STATE,
): Completed {
  return {
    type: 'completed',
    text,
    report,
    evidence_state,
    messages_state: [
      { role: 'user', content: input.content },
      { role: 'assistant', content: text },
    ],
    input_tokens: 3,
    output_tokens: 2,
    tool_usage: { attempted: 1, accepted: 1 },
  };
}

type Completed = Extract<DiagnosisStreamEvent, { type: 'completed' }>;

function jointReport(input: DiagnosisRunInput): DiagnosisReport {
  const findings = input.externalFindings ?? [];
  return DiagnosisReportSchema.parse({
    verdict: 'insufficient_evidence',
    summary: '联合调查完成',
    issue_category: 'runtime',
    confidence: 0.5,
    responsibility: 'shared',
    evidence: input.localReport?.evidence ?? [],
    joint_assessment: {
      relation: 'unverified',
      text: '本地事实与外部结论已按来源边界合并',
      verified_claims: [],
      unverified_claims: findings.map((item) => `仅来自远端 Agent 报告：${item.text}`),
      next_actions: [],
    },
    remote_conclusion: findings.at(-1) ?? null,
    external_findings: findings,
  });
}

function scriptedAgent(handlers: {
  local?: (input: DiagnosisRunInput, index: number) => DiagnosisStreamEvent;
  joint?: (input: DiagnosisRunInput, index: number) => DiagnosisStreamEvent;
}) {
  const inputs: DiagnosisRunInput[] = [];
  const agent = {
    async *stream(input: DiagnosisRunInput) {
      inputs.push(input);
      const phase = input.phase ?? 'local';
      const index = inputs.filter((item) => (item.phase ?? 'local') === phase).length - 1;
      const handler = phase === 'joint' ? handlers.joint : handlers.local;
      if (!handler) throw new Error(`unexpected ${phase} stream`);
      yield handler(input, index);
    },
  } as unknown as DiagnosisAgent;
  return { agent, inputs };
}

function remoteRegistry() {
  const calls: string[] = [];
  const tasks: unknown[] = [];
  const registry = {
    async resolve() {
      calls.push('resolve');
      return { slotId: 'compass' };
    },
    async invoke(_slot: unknown, task: unknown) {
      calls.push('invoke');
      tasks.push(task);
      return {
        data: { text: '远端请求已核查', taskId: 'task-1', contextId: 'context-1', state: 'TASK_STATE_COMPLETED' },
        truncated: false,
        limitations: ['仅覆盖当前请求'],
        audit: { slotId: 'compass', taskId: 'task-1', state: 'TASK_STATE_COMPLETED', durationMs: 2, truncated: false },
      };
    },
    async cancel() { calls.push('cancel'); },
  } as unknown as AgentSlotRegistry;
  return { registry, calls, tasks };
}

function options(harness: Harness, registry: AgentSlotRegistry, signals = EMPTY_SIGNALS) {
  return {
    knowledgeQueryLog: join(harness.directory, 'knowledge-queries.jsonl'),
    caseArchiveDir: join(harness.directory, 'knowledge-cases'),
    serverSignals: signals,
    slotRegistry: registry,
    compassAvailable: true,
    investigationBudget: { maxSeconds: 5, maxRemoteCalls: 2 },
  };
}

async function startRound(
  harness: Harness,
  agent: DiagnosisAgent,
  registry: AgentSlotRegistry,
  content: string,
  signals = EMPTY_SIGNALS,
  events: OrchestrationEvent[] = [],
) {
  return runDiagnosisRound({
    store: harness.store,
    diagnosisAgent: agent,
    capabilities: harness.capabilities,
    modelConfiguration: harness.modelConfiguration,
    conversation: harness.conversation,
    content,
    runId: 'run-initial',
    options: options(harness, registry, signals),
    onOrchestrationEvent: (event) => { events.push(event); },
  });
}

async function resumeRound(
  harness: Harness,
  agent: DiagnosisAgent,
  registry: AgentSlotRegistry,
  conversation: Harness['conversation'],
  consultationId: string,
  decision: 'approved' | 'rejected',
  signals = EMPTY_SIGNALS,
  events: OrchestrationEvent[] = [],
) {
  const resume = { consultationId, decision };
  const prepared = await prepareDiagnosisRound({
    store: harness.store,
    modelConfiguration: harness.modelConfiguration,
    conversation,
    content: '',
    runId: 'run-resumed',
    resume,
  });
  const result = await runDiagnosisRound({
    store: harness.store,
    diagnosisAgent: agent,
    capabilities: harness.capabilities,
    modelConfiguration: harness.modelConfiguration,
    conversation,
    prepared,
    content: '',
    resume,
    options: options(harness, registry, signals),
    onOrchestrationEvent: (event) => { events.push(event); },
  });
  return { prepared, result };
}

async function seedLegacyPending(
  harness: Harness,
  content: string,
  mode: 'server' | 'parallel' | 'local-continuation',
) {
  const prepared = await prepareDiagnosisRound({
    store: harness.store,
    modelConfiguration: harness.modelConfiguration,
    conversation: harness.conversation,
    content,
    runId: 'run-legacy',
  });
  const remotePlan: InvestigationPlan = {
    mode: mode === 'parallel' ? 'parallel' : 'server',
    branches: mode === 'parallel' ? ['client', 'server'] : ['server'],
    remoteSlots: ['compass'],
    clientSteps: mode === 'parallel' ? ['observe', 'source'] : [],
    reason: '历史协查记录',
    correlationReady: true,
    budget: { maxSeconds: 5, maxRemoteCalls: 2 },
    maxHandoffRounds: 1,
  };
  const initialPlan: InvestigationPlan = mode === 'local-continuation'
    ? { ...remotePlan, mode: 'local', branches: ['client'], remoteSlots: [], clientSteps: ['observe', 'source'] }
    : remotePlan;
  const state = createInvestigationStateSnapshot({
    originalContent: content,
    userMessageId: prepared.userMessage.id,
    plan: initialPlan,
  });
  state.currentPlan = remotePlan;
  if (mode === 'local-continuation') {
    state.planHistory.push(remotePlan);
    state.localReport = localReport();
    state.localText = '本地调查中间结论';
    state.handoffRoundsUsed = 1;
    harness.conversation.evidence_state = structuredClone(LOCAL_EVIDENCE_STATE);
  }
  const consultation = createExternalConsultation({
    conversationId: harness.conversation.id,
    messageId: prepared.assistantMessage.id,
    runId: 'run-legacy',
    reason: remotePlan.reason,
    outboundText: `当前用户问题：${content}`,
    redact: (text) => text,
  });
  state.consultationId = consultation.id;
  prepared.assistantMessage.content = state.localText;
  prepared.assistantMessage.status = 'completed';
  harness.conversation.consultations.push(consultation);
  harness.conversation.investigation = serializeInvestigationState(state);
  harness.conversation.run_state = 'waiting_confirmation';
  await harness.store.saveConversation(harness.conversation);
  return harness.conversation;
}

async function archivedCaseCount(directory: string): Promise<number> {
  try {
    return (await readdir(join(directory, 'knowledge-cases'))).length;
  } catch {
    return 0;
  }
}

test('显式 server 自动调用 Slot 并在同一轮完成联合报告', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      joint: (input) => completedEvent(input, '外部联合结论', jointReport(input), { entries: [], texts: {} }),
    });
    const events: OrchestrationEvent[] = [];
    const result = await startRound(
      harness, scripted.agent, remote.registry, '只查服务端，云学习接口返回 500，traceId: trace-1', PARALLEL_SIGNALS, events,
    );
    assert.equal(result.terminal, 'completed');
    assert.equal(result.terminalPersisted, true);
    assert.equal(result.conversation.run_state, 'completed');
    assert.equal(result.assistantMessage.status, 'completed');
    assert.equal(result.assistantMessage.report?.summary, '联合调查完成');
    assert.equal(result.conversation.consultations[0]?.status, 'completed');
    assert.deepEqual(scripted.inputs.map((input) => input.phase), ['joint']);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.equal(result.conversation.investigation?.originalContent, '只查服务端，云学习接口返回 500，traceId: trace-1');
    assert.equal(result.conversation.investigation?.userMessageId, result.conversation.messages[0]?.id);
    assert.equal(typeof result.conversation.investigation?.initialPlan, 'object');
    assert.equal(await archivedCaseCount(harness.directory), 1);
    assert.equal(events.some((event) => event.type === 'EXTERNAL_CONSULTATION_REQUIRED'), false);
    assert.equal(events.some((event) => event.type === 'JOINT_ASSESSMENT'), true);
  });
});

test('Compass 自动协查摘要在内网链路下保留用户原文与关联标识', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      joint: (input) => completedEvent(input, '联合结论', jointReport(input), { entries: [], texts: {} }),
    });
    const result = await startRound(
      harness,
      scripted.agent,
      remote.registry,
      '只查服务端，学员编号: student-fixture-001，联系电话: +8613800000000，traceId: trace-fixture',
      PARALLEL_SIGNALS,
    );
    const outbound = result.conversation.consultations[0]?.outbound_text ?? '';
    assert.match(outbound, /trace-fixture/);
    assert.match(outbound, /student-fixture-001/);
    assert.match(outbound, /\+8613800000000/);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.deepEqual(remote.tasks[0], { text: outbound, contextId: undefined });
    // 持久化后重新读取，外发原文与 digest 必须保持一致，不得被二次伪名化。
    const reloaded = await harness.store.getConversation(result.conversation.id);
    assert.equal(reloaded.consultations[0]?.outbound_text, outbound);
  });
});

test('带服务端特征和 traceId 的新工单仍先执行本地观察，不直接等待外发', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      local: (input) => completedEvent(input, '先检查现场', localReport('client')),
    });
    const result = await startRound(
      harness, scripted.agent, remote.registry, '云学习接口返回 500，traceId: trace-first-look', PARALLEL_SIGNALS,
    );
    assert.equal(result.terminal, 'completed');
    assert.equal(scripted.inputs.length, 1);
    assert.deepEqual(scripted.inputs[0]?.clientSteps, ['observe', 'source']);
    assert.equal(result.conversation.investigation?.initialPlan
      && (result.conversation.investigation.initialPlan as { mode: string }).mode, 'local');
    assert.equal(result.conversation.consultations.length, 0);
    assert.deepEqual(remote.calls, []);
  });
});

test('初始 local 有源码观测和关联信息时自动接续远端，外发含本地证据、判断与具体协查问题', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      local: (input) => completedEvent(input, '本地调查中间结论', localReport()),
      joint: (input) => completedEvent(input, '联合最终结论', jointReport(input)),
    });
    const result = await startRound(harness, scripted.agent, remote.registry, '页面异常，traceId: trace-local');
    assert.equal(result.terminal, 'completed', result.assistantMessage.error ?? '本地自动接续失败');
    assert.equal(result.terminalPersisted, true);
    assert.equal(result.assistantMessage.status, 'completed');
    assert.equal(result.assistantMessage.report?.summary, '联合调查完成');
    assert.equal(typeof result.conversation.investigation?.localReport, 'object');
    assert.equal(result.conversation.investigation?.currentPlan && (result.conversation.investigation.currentPlan as { mode: string }).mode, 'server');
    const consultation = result.conversation.consultations[0]!;
    assert.equal(consultation.status, 'completed');
    // 外发边界：用户原文 + 关联信息 + 本地证据（含学员标识）+ 本地判断 + 具体协查问题。
    assert.match(consultation.outbound_text, /页面异常/);
    assert.match(consultation.outbound_text, /trace-local/);
    assert.match(consultation.outbound_text, /本地调查证据/);
    assert.match(consultation.outbound_text, /throw new Error\("local"\)/);
    assert.match(consultation.outbound_text, /本地判断/);
    assert.match(consultation.outbound_text, /模型下一步问题不得进入外发正文/);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.deepEqual(remote.tasks[0], { text: consultation.outbound_text, contextId: undefined });
    assert.deepEqual(scripted.inputs.map((input) => input.phase ?? 'local'), ['local', 'joint']);
    assert.equal(await archivedCaseCount(harness.directory), 1);
  });
});

test('故障诊断缺 traceId 也自动接续外部协查，外发摘要声明关联缺口', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      local: (input) => completedEvent(input, '本地调查中间结论', localReport()),
      joint: (input) => completedEvent(input, '联合最终结论', jointReport(input)),
    });
    // 老师报障通常只有学员标识和时间窗，没有 traceId/requestId。
    const result = await startRound(
      harness, scripted.agent, remote.registry, '学而思HD 绘本页面白屏，学员编号 student-fixture-001，下午两点前后',
    );
    assert.equal(result.terminal, 'completed', result.assistantMessage.error ?? '无关联标识接续失败');
    assert.equal(result.conversation.investigation?.currentPlan
      && (result.conversation.investigation.currentPlan as { mode: string }).mode, 'server');
    const consultation = result.conversation.consultations[0]!;
    assert.equal(consultation.status, 'completed');
    assert.match(consultation.outbound_text, /绘本页面白屏/);
    assert.match(consultation.outbound_text, /缺少 traceId\/requestId，请按用户问题中的学员标识与时间窗关联/);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.deepEqual(scripted.inputs.map((input) => input.phase ?? 'local'), ['local', 'joint']);
  });
});

test('排行榜实现查询在本地知识不足时自动协查，不要求 traceId 或老师审批', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const noAnchorReport = DiagnosisReportSchema.parse({
      verdict: 'insufficient_evidence',
      summary: '本地知识未覆盖该接口实现，需要外部全栈协查',
      issue_category: 'interface',
      task_type: 'implementation',
      confidence: 0.2,
      responsibility: 'unknown',
      next_action: { target: 'external', question: '请核查英语绘本阅读排行榜的前端、H5 与服务端接口实现' },
      missing_information: ['接口实现与返回示例'],
      evidence: [],
    });
    const scripted = scriptedAgent({
      local: (input) => completedEvent(input, '本地知识未覆盖该实现', noAnchorReport, { entries: [], texts: {} }),
      joint: (input) => completedEvent(input, '排行榜接口联合结果', jointReport(input), { entries: [], texts: {} }),
    });
    const result = await startRound(
      harness, scripted.agent, remote.registry, '请查询一下英语绘本阅读排行榜的接口',
    );
    assert.equal(result.terminal, 'completed', result.assistantMessage.error ?? '无锚点接续失败');
    assert.equal(result.terminalPersisted, true);
    assert.equal(result.conversation.investigation?.currentPlan
      && (result.conversation.investigation.currentPlan as { mode: string }).mode, 'server');
    const consultation = result.conversation.consultations[0]!;
    assert.equal(consultation.status, 'completed');
    assert.match(consultation.reason, /统一外部全栈 Agent/);
    assert.match(consultation.outbound_text, /英语绘本阅读排行榜/);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.deepEqual(scripted.inputs.map((input) => input.phase ?? 'local'), ['local', 'joint']);
  }, { consult_compass: false });
});

test('本地接续批准恢复不重复 local，远端只进入 external_findings，joint 只终态一次', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      local: (input) => completedEvent(input, '本地调查中间结论', localReport()),
      joint: (input) => completedEvent(input, '联合最终结论', jointReport(input)),
    });
    const waiting = await seedLegacyPending(harness, '页面异常，traceId: trace-approved', 'local-continuation');
    const evidenceBefore = structuredClone(waiting.evidence_state);
    const originalAssistantId = waiting.messages.at(-1)!.id;
    let terminalWrites = 0;
    const save = harness.store.saveConversation.bind(harness.store);
    harness.store.saveConversation = async (conversation) => {
      if (conversation.run_state === 'completed' && conversation.messages.at(-1)?.status === 'completed') terminalWrites += 1;
      return save(conversation);
    };
    const { prepared, result } = await resumeRound(
      harness, scripted.agent, remote.registry, waiting, waiting.consultations[0]!.id, 'approved',
    );
    assert.equal(prepared.runId, 'run-resumed');
    assert.notEqual(prepared.assistantMessage.id, originalAssistantId);
    assert.equal(result.terminal, 'completed');
    assert.deepEqual(scripted.inputs.map((input) => input.phase ?? 'local'), ['joint']);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.equal(result.conversation.external_findings.length, 1);
    assert.deepEqual(result.conversation.evidence_state, evidenceBefore);
    assert.equal(JSON.stringify(result.conversation.evidence_state).includes('远端请求已核查'), false);
    assert.equal(scripted.inputs[0]?.localReport?.summary, '本地源码观测已保存');
    assert.equal(scripted.inputs[0]?.externalFindings?.length, 1);
    assert.equal(result.conversation.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(result.conversation.messages.filter((message) => message.role === 'assistant').length, 2);
    assert.equal(terminalWrites, 1);
    assert.equal(await archivedCaseCount(harness.directory), 1);
    const outcomes = await readFile(join(harness.directory, 'knowledge-queries.jsonl'), 'utf8');
    assert.equal(outcomes.trim().split('\n').length, 1);
  });
});

test('本地接续拒绝恢复保留本地报告和缺口，不重跑本地也不调用 Slot', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({ local: (input) => completedEvent(input, '本地调查中间结论', localReport()) });
    const waiting = await seedLegacyPending(harness, '页面异常，traceId: trace-rejected', 'local-continuation');
    const { result } = await resumeRound(
      harness, scripted.agent, remote.registry, waiting, waiting.consultations[0]!.id, 'rejected',
    );
    assert.equal(result.terminal, 'completed');
    assert.equal(result.conversation.consultations[0]?.status, 'rejected');
    assert.equal(result.assistantMessage.report?.summary, '本地源码观测已保存');
    assert.match(result.assistantMessage.content, /本地调查中间结论/);
    assert.match(result.assistantMessage.content, /未获外部协查批准/);
    assert.equal(scripted.inputs.length, 0);
    assert.deepEqual(remote.calls, []);
    assert.equal(result.conversation.external_findings.length, 0);
    assert.equal(await archivedCaseCount(harness.directory), 1);
  });
});

test('初始 parallel 批准后执行本地与远端两分支，保存串行且联合阶段只终态一次', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({
      local: (input) => completedEvent(input, '并行本地结果', localReport('client')),
      joint: (input) => completedEvent(input, '并行联合结果', jointReport(input)),
    });
    harness.conversation.evidence_state = LOCAL_LOG_EVIDENCE_STATE;
    const waiting = await seedLegacyPending(
      harness, '云学习接口返回 500，traceId: trace-parallel', 'parallel',
    );
    assert.equal(scripted.inputs.length, 0);
    let activeSaves = 0;
    let maxActiveSaves = 0;
    let finalWrites = 0;
    const save = harness.store.saveConversation.bind(harness.store);
    harness.store.saveConversation = async (conversation) => {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      if (conversation.run_state === 'completed' && conversation.messages.at(-1)?.status === 'completed') finalWrites += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await save(conversation);
      } finally {
        activeSaves -= 1;
      }
    };
    const events: OrchestrationEvent[] = [];
    const { result } = await resumeRound(
      harness, scripted.agent, remote.registry, waiting,
      waiting.consultations[0]!.id, 'approved', PARALLEL_SIGNALS, events,
    );
    assert.equal(result.terminal, 'completed');
    assert.deepEqual(scripted.inputs.map((input) => input.phase ?? 'local'), ['local', 'joint']);
    assert.deepEqual(remote.calls, ['resolve', 'invoke']);
    assert.equal(result.conversation.external_findings[0]?.text, '远端请求已核查');
    assert.equal(result.conversation.slot_audit.length, 1);
    assert.equal(maxActiveSaves, 1);
    assert.equal(finalWrites, 1);
    assert.equal(events.filter((event) => event.type === 'JOINT_ASSESSMENT').length, 1);
    assert.equal(events.some((event) => event.type === 'BRANCH_STATUS' && event.branch === 'client' && event.status === 'completed'), true);
    assert.equal(events.some((event) => event.type === 'BRANCH_STATUS' && event.branch === 'server' && event.status === 'completed'), true);
    assert.equal(await archivedCaseCount(harness.directory), 1);
  });
});

test('初始 parallel 拒绝后只补跑本地分支，不调用 Slot 或 joint', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({ local: (input) => completedEvent(input, '拒绝后的本地结论', localReport('client')) });
    harness.conversation.evidence_state = LOCAL_LOG_EVIDENCE_STATE;
    const waiting = await seedLegacyPending(
      harness, '云学习接口返回 500，traceId: trace-parallel-rejected', 'parallel',
    );
    const { result } = await resumeRound(
      harness, scripted.agent, remote.registry, waiting,
      waiting.consultations[0]!.id, 'rejected', PARALLEL_SIGNALS,
    );
    assert.equal(result.terminal, 'completed');
    assert.equal(result.conversation.consultations[0]?.status, 'rejected');
    assert.deepEqual(scripted.inputs.map((input) => input.phase ?? 'local'), ['local']);
    assert.deepEqual(remote.calls, []);
    assert.equal(result.assistantMessage.report?.summary, '本地源码观测已保存');
    assert.match(result.text, /未获外部协查批准/);
    assert.equal(result.conversation.external_findings.length, 0);
    assert.equal((result.conversation.investigation?.currentPlan as { mode: string }).mode, 'local');
    assert.equal(await archivedCaseCount(harness.directory), 1);
  });
});

test('无需跨侧的 orchestrated local 保持原有完成行为', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({ local: (input) => completedEvent(input, '本地最终结论', localReport('client')) });
    const result = await startRound(harness, scripted.agent, remote.registry, '只检查本地页面');
    assert.equal(result.terminal, 'completed');
    assert.equal(result.terminalPersisted, true);
    assert.equal(result.conversation.run_state, 'completed');
    assert.equal(result.assistantMessage.status, 'completed');
    assert.equal(result.assistantMessage.report?.responsibility, 'client');
    assert.equal(result.text, '本地最终结论');
    assert.equal(scripted.inputs.length, 1);
    assert.deepEqual(remote.calls, []);
    assert.equal(result.conversation.consultations.length, 0);
    assert.equal(await archivedCaseCount(harness.directory), 1);
  });
});

test('初始 server 拒绝后不调用 Slot，并由 joint 给出缺口', async () => {
  await withHarness(async (harness) => {
    const remote = remoteRegistry();
    const scripted = scriptedAgent({ joint: (input) => completedEvent(input, '没有服务端观测', jointReport(input)) });
    const waiting = await seedLegacyPending(
      harness, '只查服务端，云学习 500，requestId: req-1', 'server',
    );
    assert.equal(waiting.investigation?.initialPlan && (waiting.investigation.initialPlan as { mode: string }).mode, 'server');
    const { result } = await resumeRound(
      harness, scripted.agent, remote.registry, waiting,
      waiting.consultations[0]!.id, 'rejected', PARALLEL_SIGNALS,
    );
    assert.equal(result.terminal, 'completed');
    assert.match(result.text, /未获外部协查批准/);
    assert.equal(result.assistantMessage.report?.joint_assessment?.relation, 'unverified');
    assert.equal(scripted.inputs.length, 1);
    assert.equal(scripted.inputs[0]?.phase, 'joint');
    assert.deepEqual(remote.calls, []);
  });
});
