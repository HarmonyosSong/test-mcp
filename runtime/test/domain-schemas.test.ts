import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatMessageSchema,
  ConversationRecordSchema,
  DiagnosisReportDraftSchema,
  DiagnosisReportSchema,
  EvidenceCitationSchema,
  ModelConfigRequestSchema,
  RegisterRepositoryRequestSchema,
  ToolEventSchema,
} from '../src/domain/schemas.js';

const timestamp = '2026-09-24T08:10:07.817750+00:00';

const remoteConclusion = {
  consultation_id: 'consultation-1',
  task_id: 'task-1',
  context_id: 'context-1',
  agent_id: 'compass',
  agent_version: '2026.11',
  state: 'TASK_STATE_COMPLETED',
  text: '服务端观察到请求超时。',
  truncated: false,
  scope: ['order-service'],
  limitations: ['仅来自远端 Agent 报告'],
  request_digest: 'sha256:request-1',
  received_at: timestamp,
};

const jointAssessment = {
  relation: 'corroborated',
  text: '本地空值访问与远端超时共同指向跨侧问题。',
  verified_claims: [{
    claim: '客户端存在非空断言。',
    evidence_ids: ['ev-source-1'],
  }],
  unverified_claims: ['服务端超时仅来自远端 Agent 报告'],
  next_actions: ['复核服务端超时日志'],
};

const positiveReport = {
  verdict: 'located',
  summary: 'The null assertion causes the crash.',
  issue_category: 'runtime',
  confidence: 0.9,
  root_cause_candidates: [{
    title: 'Unsafe access',
    explanation: 'An optional value is dereferenced.',
    confidence: 0.9,
    evidence_ids: ['ev-source-1'],
  }],
  evidence: [{
    id: 'ev-source-1', kind: 'source', source: 'read_project_file', location: 'Entry.ets:2',
    excerpt: 'return profile.name!.toUpperCase();', supports: 'The optional field is dereferenced.',
  }],
};

test('report schemas apply defaults and enforce strict evidence references', () => {
  const parsed = DiagnosisReportSchema.parse(positiveReport);
  assert.equal(parsed.severity, 'unknown');
  assert.equal(parsed.responsibility, 'unknown');
  assert.equal(parsed.task_type, 'unknown');
  assert.equal(parsed.next_action, null);
  assert.equal(parsed.joint_assessment, null);
  assert.equal(parsed.remote_conclusion, null);
  assert.deepEqual(parsed.external_findings, []);
  assert.deepEqual(parsed.ruled_out, []);
  assert.equal(parsed.evidence[0]?.kind, 'source');

  const snapshotEvidence = DiagnosisReportSchema.parse({
    ...positiveReport,
    evidence: [{
      ...positiveReport.evidence[0],
      source_context: {
        repository_id: 'group/client-app',
        resolved_commit: 'a'.repeat(40),
        path: 'Entry.ets',
      },
    }],
  });
  assert.equal(snapshotEvidence.evidence[0]?.source_context?.resolved_commit, 'a'.repeat(40));

  assert.equal(DiagnosisReportSchema.safeParse({ ...positiveReport, injected: true }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({
    ...positiveReport,
    evidence: [{ ...positiveReport.evidence[0], forged: true }],
  }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({ ...positiveReport, evidence: [] }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({ ...positiveReport, likely_location: 'null' }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({
    ...positiveReport,
    root_cause_candidates: [{ ...positiveReport.root_cause_candidates[0], evidence_ids: ['unknown'] }],
  }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({
    ...positiveReport,
    evidence: [positiveReport.evidence[0], { ...positiveReport.evidence[0], excerpt: ` ${positiveReport.evidence[0].excerpt} ` }],
  }).success, false);
});

test('orchestration reports accept runtime conclusions and structured next actions', () => {
  const parsed = DiagnosisReportSchema.parse({
    ...positiveReport,
    responsibility: 'shared',
    next_action: {
      target: 'server',
      question: '请按 request_id 核查服务端超时原因',
    },
    joint_assessment: jointAssessment,
    remote_conclusion: remoteConclusion,
    external_findings: [remoteConclusion],
  });
  assert.equal(parsed.responsibility, 'shared');
  assert.equal(parsed.next_action?.target, 'server');
  const external = DiagnosisReportSchema.parse({
    ...positiveReport,
    task_type: 'implementation',
    responsibility: 'unknown',
    next_action: { target: 'external', question: '请核查排行榜的前端、H5 与服务端实现' },
  });
  assert.equal(external.task_type, 'implementation');
  assert.equal(external.next_action?.target, 'external');
  assert.equal(parsed.joint_assessment?.verified_claims[0]?.evidence_ids[0], 'ev-source-1');
  assert.equal(parsed.remote_conclusion?.consultation_id, 'consultation-1');
  assert.equal(parsed.external_findings.length, 1);

  assert.equal(DiagnosisReportSchema.safeParse({
    ...positiveReport,
    next_action: { target: 'server', question: '   ' },
  }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({
    ...positiveReport,
    joint_assessment: {
      ...jointAssessment,
      verified_claims: ['本地结论仍使用旧字符串格式'],
    },
  }).success, false);
  assert.equal(DiagnosisReportSchema.safeParse({
    ...positiveReport,
    joint_assessment: {
      ...jointAssessment,
      verified_claims: [{ claim: '没有证据的主张', evidence_ids: [] }],
    },
  }).success, false);
});

test('draft evidence only permits citations and positive candidates need linked citations', () => {
  const draft = DiagnosisReportDraftSchema.parse({
    ...positiveReport,
    evidence: [{ id: 'ev-source-1', excerpt: 'literal excerpt', supports: 'supports claim' }],
  });
  assert.equal(draft.severity, 'unknown');
  assert.equal(draft.responsibility, 'unknown');
  assert.equal(draft.next_action, null);
  assert.equal(draft.joint_assessment, null);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    remote_conclusion: remoteConclusion,
  }).success, false);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    external_findings: [remoteConclusion],
  }).success, false);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    remote_conclusion: null,
    external_findings: [],
  }).success, false);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    likely_location: 'null',
    evidence: [{ id: 'ev-source-1', excerpt: 'literal excerpt', supports: 'supports claim' }],
  }).success, false);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    verdict: 'insufficient_evidence',
    root_cause_candidates: [{ ...positiveReport.root_cause_candidates[0], evidence_ids: [] }],
    evidence: [],
  }).success, false);
  assert.equal(EvidenceCitationSchema.safeParse({
    id: 'ev-source-1', excerpt: 'x', supports: 'claim', kind: 'source',
  }).success, false);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    evidence: [{ id: 'ev-source-1', excerpt: 'literal excerpt', supports: 'supports claim', source: 'forged' }],
  }).success, false);
  assert.equal(DiagnosisReportDraftSchema.safeParse({
    ...positiveReport,
    evidence: [{
      id: 'ev-source-1',
      excerpt: 'literal excerpt',
      supports: 'supports claim',
      source_context: {
        repository_id: 'forged-repository',
        resolved_commit: 'b'.repeat(40),
        path: 'Entry.ets',
      },
    }],
  }).success, false);
});

test('message and tool schemas preserve optional, nullable, and default behavior', () => {
  const message = ChatMessageSchema.parse({ role: 'assistant', created_at: timestamp });
  assert.equal(message.content, '');
  assert.equal(message.status, 'completed');
  assert.deepEqual(message.steps, []);
  assert.deepEqual(message.tool_usage, {});
  assert.match(message.id, /^msg-[a-f0-9]{10}$/);

  const tool = ToolEventSchema.parse({ tool: 'read_file', status: 'completed', summary: 'read', created_at: timestamp });
  assert.match(tool.id, /^tool-[a-f0-9]{8}$/);
  assert.equal(tool.arguments_summary, null);
  assert.equal(tool.duration_ms, null);
  assert.equal(ChatMessageSchema.safeParse({ role: 'system', created_at: timestamp }).success, false);
  assert.equal(ToolEventSchema.safeParse({ tool: 'x', status: 'ok', summary: 'x', duration_ms: 1.2, created_at: timestamp }).success, false);
});

test('legacy conversation records validate persisted shape and fill historical defaults', () => {
  const record = ConversationRecordSchema.parse({
    id: 'conv-legacy',
    title: 'legacy',
    messages: [{ id: 'msg-legacy', role: 'user', content: 'hello', created_at: timestamp }],
    created_at: timestamp,
    updated_at: timestamp,
    legacy_extension: 'Pydantic ignores extra record fields',
  });
  assert.equal(record.model_override, null);
  assert.equal(record.run_state, 'idle');
  assert.equal(record.consult_compass, false);
  assert.equal(record.investigation, null);
  assert.deepEqual(record.consultations, []);
  assert.deepEqual(record.external_findings, []);
  assert.deepEqual(record.slot_audit, []);
  assert.deepEqual(record.messages_state, []);
  assert.deepEqual(record.evidence_state, {});
  assert.equal(record.messages[0]?.status, 'completed');
  assert.equal('legacy_extension' in record, false);

  assert.equal(ConversationRecordSchema.safeParse({ ...record, messages: [{ ...record.messages[0], role: 'system' }] }).success, false);
  assert.equal(ConversationRecordSchema.safeParse({ ...record, model_override: 'x'.repeat(251) }).success, false);
  assert.equal(ConversationRecordSchema.safeParse({ ...record, created_at: 'yesterday' }).success, false);
});

test('conversation orchestration fields preserve plans, consultations, findings, and audits', () => {
  const record = ConversationRecordSchema.parse({
    id: 'conv-orchestration',
    title: 'joint investigation',
    run_state: 'waiting_confirmation',
    consult_compass: true,
    investigation: {
      initial_plan: { mode: 'local', branches: ['client'] },
      current_plan: { mode: 'server', branches: ['server'], remoteSlots: ['compass'] },
      plan_change_reason: '本地报告给出 server 路由',
      branch_states: { client: 'completed', server: 'pending' },
    },
    consultations: [{
      id: 'consultation-1',
      conversation_id: 'conv-orchestration',
      message_id: 'msg-1',
      run_id: 'run-1',
      status: 'pending',
      reason: '继续核查服务端',
      outbound_text: '已脱敏的问题和关联标识',
      outbound_digest: 'sha256:outbound-1',
      redaction_version: 'v1',
      attachment_items: [],
      expires_at: timestamp,
      task_id: null,
      context_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    }],
    external_findings: [remoteConclusion],
    slot_audit: [{
      operation: 'invoke',
      slotId: 'compass',
      taskId: 'task-1',
      state: 'TASK_STATE_COMPLETED',
      durationMs: 12.5,
      truncated: false,
    }],
    created_at: timestamp,
    updated_at: timestamp,
  });
  assert.equal(record.run_state, 'waiting_confirmation');
  assert.equal(record.consult_compass, true);
  assert.deepEqual(record.investigation?.current_plan, {
    mode: 'server', branches: ['server'], remoteSlots: ['compass'],
  });
  assert.deepEqual(record.consultations[0]?.attachment_items, []);
  assert.equal(record.external_findings[0]?.task_id, 'task-1');
  assert.equal(record.slot_audit[0]?.slotId, 'compass');

  assert.equal(ConversationRecordSchema.safeParse({ ...record, run_state: 'streaming' }).success, false);
  assert.equal(ConversationRecordSchema.safeParse({
    ...record,
    consultations: [{ ...record.consultations[0], attachment_items: ['source.ets'] }],
  }).success, false);
});

test('request schemas normalize text and expose Python None defaults as null', async () => {
  const { CreateConversationRequestSchema, SendMessageRequestSchema, UpdateConversationRequestSchema } = await import('../src/domain/schemas.js');
  assert.deepEqual(CreateConversationRequestSchema.parse({}), { title: null });
  assert.deepEqual(SendMessageRequestSchema.parse({ content: '  hello  ' }), { content: 'hello' });
  assert.deepEqual(UpdateConversationRequestSchema.parse({}), {});
});

test('model config validates credential-free HTTP URLs and key mode', () => {
  const parsed = ModelConfigRequestSchema.parse({
    provider: ' openai ', model_name: ' gpt-5 ', base_url: ' https://api.example.com/v1/// ',
    api_key: 'secret', no_api_key: false,
  });
  assert.equal(parsed.provider, 'openai');
  assert.equal(parsed.model_name, 'gpt-5');
  assert.equal(parsed.base_url, 'https://api.example.com/v1');
  assert.equal(parsed.compatibility_mode, 'standard');

  for (const base_url of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com?x=1', '/relative']) {
    assert.equal(ModelConfigRequestSchema.safeParse({ provider: 'openai', model_name: 'x', base_url }).success, false);
  }
  assert.equal(ModelConfigRequestSchema.safeParse({
    provider: 'openai', model_name: 'x', api_key: 'secret', no_api_key: true,
  }).success, false);
  assert.equal(ModelConfigRequestSchema.safeParse({
    provider: 'openai', model_name: 'x', api_key: 'k'.repeat(4_097),
  }).success, false);
});

test('repository registration rejects embedded credentials while accepting SSH forms', () => {
  assert.equal(RegisterRepositoryRequestSchema.safeParse({
    name: 'repo', url: 'https://user:pass@example.com/repo.git',
  }).success, false);
  assert.equal(RegisterRepositoryRequestSchema.safeParse({
    name: 'repo', url: 'git@example.com:team/repo.git',
  }).success, true);
  assert.equal(RegisterRepositoryRequestSchema.safeParse({
    name: 'repo', url: 'file:///Users/tal/project.git',
  }).success, true);
  assert.equal(RegisterRepositoryRequestSchema.safeParse({
    name: 'repo', url: 'file:/Users/tal/project.git',
  }).success, true);
  assert.equal(RegisterRepositoryRequestSchema.safeParse({
    name: 'repo', url: 'file://remote-host/project.git',
  }).success, false);

  for (const url of [
    'https://example.com/repo.git?token=secret',
    'https://example.com/repo.git?',
    'http://example.com/repo.git#branch',
    'ssh://git@example.com/team/repo.git?token=secret',
    'ssh://git@example.com/team/repo.git#branch',
  ]) {
    assert.equal(RegisterRepositoryRequestSchema.safeParse({ name: 'repo', url }).success, false, url);
  }
});
