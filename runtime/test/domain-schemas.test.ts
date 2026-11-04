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
  assert.deepEqual(parsed.ruled_out, []);
  assert.equal(parsed.evidence[0]?.kind, 'source');

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

test('draft evidence only permits citations and positive candidates need linked citations', () => {
  const draft = DiagnosisReportDraftSchema.parse({
    ...positiveReport,
    evidence: [{ id: 'ev-source-1', excerpt: 'literal excerpt', supports: 'supports claim' }],
  });
  assert.equal(draft.severity, 'unknown');
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
  assert.deepEqual(record.messages_state, []);
  assert.deepEqual(record.evidence_state, {});
  assert.equal(record.messages[0]?.status, 'completed');
  assert.equal('legacy_extension' in record, false);

  assert.equal(ConversationRecordSchema.safeParse({ ...record, messages: [{ ...record.messages[0], role: 'system' }] }).success, false);
  assert.equal(ConversationRecordSchema.safeParse({ ...record, model_override: 'x'.repeat(251) }).success, false);
  assert.equal(ConversationRecordSchema.safeParse({ ...record, created_at: 'yesterday' }).success, false);
});

test('request schemas normalize text and expose Python None defaults as null', async () => {
  const { CreateConversationRequestSchema, SendMessageRequestSchema, UpdateConversationRequestSchema } = await import('../src/domain/schemas.js');
  assert.deepEqual(CreateConversationRequestSchema.parse({}), {
    title: null, workspace_path: null, repository_id: null, branch: null,
  });
  assert.deepEqual(SendMessageRequestSchema.parse({ content: '  hello  ' }), { content: 'hello' });
  assert.deepEqual(UpdateConversationRequestSchema.parse({}), { title: null });
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
