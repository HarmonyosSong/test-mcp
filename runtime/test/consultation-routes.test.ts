import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';
import { Hono } from 'hono';

import type { AuthVariables } from '../src/auth/index.js';
import type { CapabilityMcp } from '../src/capabilities/mcp.js';
import type { DiagnosisAgent, DiagnosisRunInput } from '../src/diagnosis/agent.js';
import { DiagnosisReportSchema } from '../src/domain/schemas.js';
import { createConversationRoutes } from '../src/http/conversations.js';
import type { ModelConfiguration } from '../src/model/configuration.js';
import type { AgentSlotRegistry } from '../src/orchestration/agent-slot-registry.js';
import type { ServerSignals } from '../src/orchestration/server-signals.js';
import { ProductStore } from '../src/product/store.js';

const SIGNALS: ServerSignals = { version: 1, serviceNames: [], apiPrefixes: [], errorCodePatterns: [] };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'consultation-routes-'));
  const store = new ProductStore(createClient({ url: `file:${join(directory, 'runtime.db')}` }));
  const conversation = await store.createConversation({
    owner_subject: 'teacher-1',
    workspace_path: '/fixture',
    consult_compass: true,
  });
  const remoteCalls: string[] = [];
  const registry = {
    async resolve() { return { slotId: 'compass' }; },
    async invoke(_slot: unknown, task: { text: string }) {
      remoteCalls.push(task.text);
      return {
        data: { text: '远端已核查', taskId: 'task-route', contextId: 'ctx-route', state: 'TASK_STATE_COMPLETED' },
        truncated: false,
        limitations: [],
        audit: { slotId: 'compass', taskId: 'task-route', state: 'TASK_STATE_COMPLETED', durationMs: 1, truncated: false },
      };
    },
    async cancel() {},
  } as unknown as AgentSlotRegistry;
  const inputs: DiagnosisRunInput[] = [];
  const agent = {
    async *stream(input: DiagnosisRunInput) {
      inputs.push(input);
      const localReport = DiagnosisReportSchema.parse({
        verdict: 'insufficient_evidence',
        summary: '本地事实已保留',
        issue_category: 'runtime',
        confidence: 0.4,
        responsibility: 'server',
        next_action: { target: 'server', question: '核查请求失败原因' },
        evidence: [{
          id: 'local-source', kind: 'source', source: 'read_project_file',
          location: 'Entry.ets:1', excerpt: 'throw new Error("local")', supports: '本地异常路径',
        }],
      });
      const report = input.phase === 'joint'
        ? DiagnosisReportSchema.parse({
            ...localReport,
            summary: '联合调查完成',
            joint_assessment: {
              relation: 'unverified', text: '远端结论仅作外部发现',
              verified_claims: [], unverified_claims: ['远端已核查'], next_actions: [],
            },
          })
        : localReport;
      yield {
        type: 'completed',
        text: input.phase === 'joint' ? '联合报告' : '本地中间报告',
        report,
        evidence_state: { entries: [{ id: 'local-source', kind: 'source' }], texts: {} },
        messages_state: [],
        input_tokens: null,
        output_tokens: null,
        tool_usage: {},
      } as const;
    },
  } as unknown as DiagnosisAgent;
  let subject = 'teacher-1';
  const routes = createConversationRoutes(
    store,
    agent,
    {
      createKnowledgeSession: async () => null,
      createRepositorySession: async () => ({ toolsets: {}, client: { disconnect: async () => undefined } }),
    } as unknown as CapabilityMcp,
    { enabled: true, redact: (text: string) => text } as unknown as ModelConfiguration,
    {
      knowledgeQueryLog: join(directory, 'queries.jsonl'),
      caseArchiveDir: join(directory, 'cases'),
      serverSignals: SIGNALS,
      slotRegistry: registry,
      compassAvailable: true,
      investigationBudget: { maxSeconds: 5, maxRemoteCalls: 2 },
    },
  );
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('identity', { subject, displayName: 'IT 老师', issuer: 'test' });
    await next();
  });
  app.route('/', routes);
  return {
    directory, store, conversation, app, remoteCalls, inputs,
    setSubject: (value: string) => { subject = value; },
  };
}

async function startWaiting(app: Hono<{ Variables: AuthVariables }>, id: string) {
  const response = await app.request(`/conversations/${id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '页面异常，traceId: trace-route' }),
  });
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.match(events, /EXTERNAL_CONSULTATION_REQUIRED/);
  assert.doesNotMatch(events, /RUN_FINISHED|RUN_ERROR/);
  return events;
}

test('审批路由执行所有权、摘要和恢复 SSE 校验', async () => {
  const harness = await setup();
  try {
    const { app, conversation, store, remoteCalls } = harness;
    await startWaiting(app, conversation.id);
    const waiting = await store.getConversation(conversation.id);
    const consultation = waiting.consultations[0]!;
    const originalOutboundText = consultation.outbound_text;
    const originalMessages = waiting.messages.length;
    const approvePath = `/conversations/${conversation.id}/consultations/${consultation.id}/approve`;

    harness.setSubject('teacher-2');
    const forbidden = await app.request(approvePath, { method: 'POST', body: '{}' });
    assert.equal(forbidden.status, 403);
    harness.setSubject('teacher-1');

    const changed = await app.request(approvePath, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outbound_text: '不得修改外发内容' }),
    });
    assert.equal(changed.status, 422);
    assert.deepEqual(remoteCalls, []);

    waiting.consultations[0]!.outbound_text += 'tampered';
    await store.saveConversation(waiting);
    const tampered = await app.request(approvePath, { method: 'POST', body: '{}' });
    assert.equal(tampered.status, 409);
    assert.deepEqual(remoteCalls, []);

    const restored = await store.getConversation(conversation.id);
    restored.consultations[0]!.outbound_text = originalOutboundText;
    await store.saveConversation(restored);
    const approved = await app.request(approvePath, { method: 'POST', body: '{}' });
    assert.equal(approved.status, 200);
    const resumedEvents = await approved.text();
    assert.match(resumedEvents, /INVESTIGATION_PLAN/);
    assert.match(resumedEvents, /JOINT_ASSESSMENT/);
    assert.match(resumedEvents, /RUN_FINISHED/);
    assert.doesNotMatch(resumedEvents, /RUN_ERROR/);
    assert.equal(remoteCalls.length, 1);

    const completed = await store.getConversation(conversation.id);
    assert.equal(completed.run_state, 'completed');
    assert.equal(completed.consultations[0]?.status, 'completed');
    assert.equal(completed.external_findings.length, 1);
    assert.equal(completed.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(completed.messages.length, originalMessages + 1);
    assert.equal(harness.inputs.filter((input) => (input.phase ?? 'local') === 'local').length, 1);
    assert.equal(harness.inputs.filter((input) => input.phase === 'joint').length, 1);
  } finally {
    await harness.store.close();
    await rm(harness.directory, { recursive: true, force: true });
  }
});

test('过期确认自动形成保留本地事实的终态，不卡住会话也不调用远端', async () => {
  const harness = await setup();
  try {
    const { app, conversation, store, remoteCalls } = harness;
    await startWaiting(app, conversation.id);
    const waiting = await store.getConversation(conversation.id);
    const consultation = waiting.consultations[0]!;
    waiting.consultations[0]!.expires_at = '2020-01-01T00:00:00.000Z';
    await store.saveConversation(waiting);

    const response = await app.request(`/conversations/${conversation.id}/consultations/${consultation.id}/approve`, {
      method: 'POST', body: '{}',
    });
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /RUN_FINISHED/);
    assert.doesNotMatch(events, /RUN_ERROR/);
    assert.deepEqual(remoteCalls, []);
    const completed = await store.getConversation(conversation.id);
    assert.equal(completed.run_state, 'completed');
    assert.equal(completed.consultations[0]?.status, 'expired');
    assert.match(completed.messages.at(-1)?.content ?? '', /确认已过期/);
    assert.match(completed.messages.at(-1)?.report?.summary ?? '', /本地事实/);
  } finally {
    await harness.store.close();
    await rm(harness.directory, { recursive: true, force: true });
  }
});

test('没有 owner 的旧会话审批失败关闭，拒绝恢复保留本地报告且零远端调用', async () => {
  const harness = await setup();
  try {
    const { app, conversation, store, remoteCalls } = harness;
    await startWaiting(app, conversation.id);
    const waiting = await store.getConversation(conversation.id);
    const consultation = waiting.consultations[0]!;
    waiting.owner_subject = null;
    await store.saveConversation(waiting);
    const legacy = await app.request(`/conversations/${conversation.id}/consultations/${consultation.id}/approve`, {
      method: 'POST', body: '{}',
    });
    assert.equal(legacy.status, 403);

    waiting.owner_subject = 'teacher-1';
    await store.saveConversation(waiting);
    const rejected = await app.request(`/conversations/${conversation.id}/consultations/${consultation.id}/reject`, {
      method: 'POST', body: '{}',
    });
    assert.equal(rejected.status, 200);
    const events = await rejected.text();
    assert.match(events, /RUN_FINISHED/);
    assert.doesNotMatch(events, /RUN_ERROR/);
    assert.deepEqual(remoteCalls, []);
    const completed = await store.getConversation(conversation.id);
    assert.equal(completed.consultations[0]?.status, 'rejected');
    assert.equal(completed.run_state, 'completed');
    assert.match(completed.messages.at(-1)?.report?.summary ?? '', /本地事实/);
  } finally {
    await harness.store.close();
    await rm(harness.directory, { recursive: true, force: true });
  }
});
