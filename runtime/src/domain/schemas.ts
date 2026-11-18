import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });
const nowIsoDateTime = () => new Date().toISOString();
const nullableText = z.string().nullable();
const nullableLocation = z.string()
  .refine((value) => value.trim().toLowerCase() !== 'null', 'use null instead of the string "null"')
  .nullable();
const defaultEvidenceId = () => `ev-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const defaultToolId = () => `tool-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const defaultMessageId = () => `msg-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const defaultConversationId = () => `conv-${randomUUID().replaceAll('-', '').slice(0, 10)}`;

export const ClientPlatformSchema = z.enum(['harmony', 'android', 'ios']);
export const ClientProductLineSchema = z.enum(['xueersi', 'xuejiayun']);
export const ClientFormFactorSchema = z.enum(['phone', 'pad', 'universal']);
export const SourceCompletenessSchema = z.enum(['complete', 'partial', 'unknown']);

export const VerdictSchema = z.enum([
  'located',
  'probable',
  'insufficient_evidence',
  'tool_error',
]);
export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);
export const EvidenceKindSchema = z.enum(['user', 'log', 'source', 'config', 'tool']);
export const ChatMessageStatusSchema = z.enum(['streaming', 'completed', 'failed']);
export const ResponsibilitySchema = z.enum(['client', 'server', 'shared', 'unknown']);
export const DiagnosisTaskTypeSchema = z.enum(['rule', 'implementation', 'incident', 'unknown']);
export const RunStateSchema = z.enum([
  'idle',
  'running',
  'waiting_confirmation',
  'completed',
  'failed',
  'cancelled',
]);

export const RemoteConclusionSchema = z.strictObject({
  consultation_id: z.string().min(1),
  task_id: nullableText,
  context_id: nullableText,
  agent_id: nullableText,
  agent_version: nullableText,
  state: nullableText,
  text: z.string(),
  truncated: z.boolean(),
  scope: z.array(z.string()),
  limitations: z.array(z.string()),
  request_digest: z.string().min(1),
  received_at: isoDateTime,
});

export const VerifiedClaimSchema = z.strictObject({
  claim: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)).min(1),
});

export const JointAssessmentSchema = z.strictObject({
  relation: z.enum(['corroborated', 'conflicting', 'unverified']),
  text: z.string(),
  verified_claims: z.array(VerifiedClaimSchema),
  unverified_claims: z.array(z.string()),
  next_actions: z.array(z.string()),
});

export const NextActionSchema = z.strictObject({
  // server 仅用于兼容旧报告；新路由统一使用 external，不预设对端只负责服务端。
  target: z.enum(['client', 'server', 'external', 'user']),
  question: z.string().trim().min(1),
});

// Runtime-owned identity for source observations. Model drafts intentionally do not
// expose this field; it is derived from the conversation's bound snapshot.
export const SourceSnapshotIdentitySchema = z.strictObject({
  repository_id: z.string().trim().min(1).max(300),
  resolved_commit: z.string().trim().min(1).max(128),
});

export const SourceObservationContextSchema = z.strictObject({
  ...SourceSnapshotIdentitySchema.shape,
  path: z.string().trim().min(1).max(2_000),
});

// Runtime-owned bindings for every repository mounted into a conversation's
// immutable source workspace. The shell uses an empty mount_path.
export const SourceRepositoryBindingSchema = z.strictObject({
  repository_id: z.string().trim().min(1).max(300),
  repository_name: z.string().trim().min(1).max(300),
  requested_ref: z.string().trim().min(1).max(500),
  resolved_commit: z.string().trim().min(1).max(128),
  role: z.enum(['shell', 'component', 'config']),
  mount_path: z.string().trim().max(2_000),
}).superRefine((value, ctx) => {
  const parts = value.mount_path.split('/');
  if (value.mount_path !== '' && (
    value.mount_path.startsWith('/') ||
    value.mount_path.includes('\\') ||
    /^[A-Za-z]:/.test(value.mount_path) ||
    parts.some((part) => !part || part === '.' || part === '..')
  )) {
    ctx.addIssue({ code: 'custom', path: ['mount_path'], message: 'mount_path 必须是安全的相对路径' });
  }
  if (value.role === 'shell' && value.mount_path !== '') {
    ctx.addIssue({ code: 'custom', path: ['mount_path'], message: 'shell 仓库的 mount_path 必须为空' });
  }
  if (value.role !== 'shell' && value.mount_path === '') {
    ctx.addIssue({ code: 'custom', path: ['mount_path'], message: 'component/config 仓库必须提供 mount_path' });
  }
});

export const EvidenceSchema = z.strictObject({
  id: z.string().default(defaultEvidenceId),
  kind: EvidenceKindSchema,
  source: z.string(),
  location: nullableText.default(null),
  excerpt: z.string().max(2_000),
  supports: z.string(),
  // 只能由 Runtime 的观测适配器写入（如协查 consultation_id），模型草稿没有该字段。
  observation_context: z.record(z.string(), z.unknown()).optional(),
  // 只能由 Runtime 根据会话绑定的源码快照写入，模型草稿没有该字段。
  source_context: SourceObservationContextSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.source_context && value.kind !== 'source') {
    ctx.addIssue({
      code: 'custom',
      path: ['source_context'],
      message: 'source_context is only valid for source observations',
    });
  }
});

export const EvidenceCitationSchema = z.strictObject({
  id: z.string().min(1),
  excerpt: z.string().min(1).max(2_000),
  supports: z.string().min(1).max(500),
});

export const RootCauseCandidateSchema = z.object({
  title: z.string(),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()).default([]),
});

const reportFields = {
  verdict: VerdictSchema,
  severity: SeveritySchema.default('unknown'),
  summary: z.string(),
  issue_category: z.string(),
  task_type: DiagnosisTaskTypeSchema.default('unknown'),
  likely_location: nullableLocation.default(null),
  root_cause_candidates: z.array(RootCauseCandidateSchema).default([]),
  ruled_out: z.array(z.string()).default([]),
  missing_information: z.array(z.string()).default([]),
  checks_performed: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  responsibility: ResponsibilitySchema.default('unknown'),
  next_action: NextActionSchema.nullable().default(null),
  joint_assessment: JointAssessmentSchema.nullable().default(null),
};

function validateReportReferences(
  value: { verdict: z.infer<typeof VerdictSchema>; root_cause_candidates: z.infer<typeof RootCauseCandidateSchema>[] },
  evidence: Array<{ id: string; excerpt: string }>,
  ctx: z.RefinementCtx,
  evidenceLabel: string,
) {
  const pairs = new Set<string>();
  evidence.forEach((item, index) => {
    const pair = JSON.stringify([item.id, item.excerpt.trim()]);
    if (pairs.has(pair)) {
      ctx.addIssue({
        code: 'custom',
        path: [evidenceLabel, index],
        message: 'duplicate citation of the same observation and excerpt',
      });
    }
    pairs.add(pair);
  });

  const ids = new Set(evidence.map((item) => item.id));
  value.root_cause_candidates.forEach((candidate, index) => {
    if (candidate.evidence_ids.length === 0 || candidate.evidence_ids.some((id) => !ids.has(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['root_cause_candidates', index, 'evidence_ids'],
        message: 'every candidate must cite evidence present in the report',
      });
    }
  });

  if (
    (value.verdict === 'located' || value.verdict === 'probable') &&
    value.root_cause_candidates.length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['root_cause_candidates'],
      message: 'positive diagnoses require every candidate linked to evidence',
    });
  }
}

export const DiagnosisReportSchema = z
  .strictObject({
    ...reportFields,
    evidence: z.array(EvidenceSchema).default([]),
    // 外部结论只能由 Runtime 合并，绝不出现在模型草稿 Schema 中。
    remote_conclusion: RemoteConclusionSchema.nullable().default(null),
    external_findings: z.array(RemoteConclusionSchema).default([]),
  })
  .superRefine((value, ctx) => validateReportReferences(value, value.evidence, ctx, 'evidence'));

export const DiagnosisReportDraftSchema = z
  .strictObject({
    ...reportFields,
    evidence: z.array(EvidenceCitationSchema).default([]),
  })
  .superRefine((value, ctx) => validateReportReferences(value, value.evidence, ctx, 'evidence'));

export const ToolEventSchema = z.object({
  id: z.string().default(defaultToolId),
  tool: z.string(),
  status: z.string(),
  summary: z.string(),
  arguments_summary: z.string().max(500).nullable().default(null),
  result_summary: z.string().max(500).nullable().default(null),
  duration_ms: z.number().int().nullable().default(null),
  created_at: isoDateTime.default(nowIsoDateTime),
});

export const ChatMessageSchema = z.object({
  id: z.string().default(defaultMessageId),
  role: z.enum(['user', 'assistant']),
  content: z.string().default(''),
  steps: z.array(ToolEventSchema).default([]),
  status: ChatMessageStatusSchema.default('completed'),
  error: nullableText.default(null),
  report: DiagnosisReportSchema.nullable().default(null),
  input_tokens: z.number().int().nullable().default(null),
  output_tokens: z.number().int().nullable().default(null),
  tool_usage: z.record(z.string(), z.union([z.number().int(), z.string(), z.null()])).default({}),
  created_at: isoDateTime.default(nowIsoDateTime),
});

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ExternalConsultationSchema = z.strictObject({
  id: z.string().min(1),
  conversation_id: z.string().min(1),
  message_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.enum([
    'pending',
    'approved',
    'rejected',
    'sent',
    'completed',
    'failed',
    'cancel_requested',
    'unknown',
    'expired',
  ]),
  reason: z.string(),
  outbound_text: z.string(),
  outbound_digest: z.string().min(1),
  redaction_version: z.string().min(1),
  attachment_items: z.array(z.string()).max(0),
  expires_at: isoDateTime,
  task_id: nullableText,
  context_id: nullableText,
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

export const SlotAuditSchema = z.strictObject({
  operation: z.enum(['invoke', 'cancel']),
  slotId: z.string().min(1),
  taskId: nullableText,
  state: nullableText,
  durationMs: z.number().min(0),
  truncated: z.boolean(),
});

/**
 * 对照端源码快照绑定（跨端实现对比）：与事故端字段同一来源（createConversationSource），
 * 但独立存放——事故 scope（platform/version/source_repositories）绝不被对照绑定改写。
 * 对照端同时只保留一个快照；换绑不淘汰已登记观测（证据自带 source_context）。
 */
export const CompareSourceBindingSchema = z.object({
  platform: ClientPlatformSchema,
  product_line: ClientProductLineSchema.nullable().default(null),
  form_factor: ClientFormFactorSchema.nullable().default(null),
  version: nullableText.default(null),
  build: nullableText.default(null),
  workspace_path: z.string(),
  repository_id: z.string(),
  repository_name: z.string(),
  requested_ref: z.string(),
  resolved_commit: z.string(),
  source_repositories: z.array(SourceRepositoryBindingSchema).default([]),
  source_completeness: SourceCompletenessSchema.nullable().default(null),
  source_limitations: z.array(z.string()).default([]),
  bound_at: isoDateTime.default(nowIsoDateTime),
});

export const ConversationRecordSchema = z.object({
  id: z.string().default(defaultConversationId),
  title: z.string().default('新会话'),
  channel: z.enum(['web', 'yach_im']).optional().default('web'),
  owner_subject: nullableText.optional().default(null),
  workspace_path: nullableText.optional().default(null),
  repository_id: nullableText.optional().default(null),
  repository_name: nullableText.optional().default(null),
  requested_ref: nullableText.optional().default(null),
  resolved_commit: nullableText.optional().default(null),
  source_repositories: z.array(SourceRepositoryBindingSchema).default([]),
  source_completeness: SourceCompletenessSchema.nullable().optional().default(null),
  source_limitations: z.array(z.string()).default([]),
  compare_source: CompareSourceBindingSchema.nullable().optional().default(null),
  platform: ClientPlatformSchema.nullable().optional().default(null),
  product_line: ClientProductLineSchema.nullable().optional().default(null),
  form_factor: ClientFormFactorSchema.nullable().optional().default(null),
  version: nullableText.optional().default(null),
  build: nullableText.optional().default(null),
  model_override: z.string().max(250).nullable().optional().default(null),
  run_state: RunStateSchema.default('idle'),
  consultations: z.array(ExternalConsultationSchema).default([]),
  external_findings: z.array(RemoteConclusionSchema).default([]),
  slot_audit: z.array(SlotAuditSchema).default([]),
  messages: z.array(ChatMessageSchema).default([]),
  messages_state: z.array(JsonObjectSchema).default([]),
  evidence_state: JsonObjectSchema.default({}),
  created_at: isoDateTime.default(nowIsoDateTime),
  updated_at: isoDateTime.default(nowIsoDateTime),
});

export const ConversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  channel: z.enum(['web', 'yach_im']).optional().default('web'),
  repository_name: nullableText.default(null),
  message_count: z.number().int(),
  updated_at: isoDateTime,
});

// A conversation starts unbound. Platform, product line, version and source
// identity are resolved from the user's messages and correlated observations.
// Keeping this request strict prevents callers from reintroducing manual repo
// or branch binding through the HTTP API.
export const CreateConversationRequestSchema = z.strictObject({
  title: z.string().trim().max(120).nullable().default(null).transform((value) => value || null),
});

export const SendMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});
export const UpdateConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).nullable().optional(),
  model_override: z.string().trim().max(250).nullable().optional(),
});

const credentialFreeHttpUrl = (value: string) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.hostname.length > 0 &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  );
};

export const ModelConfigRequestSchema = z
  .object({
    provider: z.string().min(2).max(50),
    model_name: z.string().min(1).max(200),
    base_url: z.string().trim().max(2_000).nullable().default(null),
    api_key: z.string().max(4_096).nullable().default(null),
    no_api_key: z.boolean().default(false),
    compatibility_mode: z.enum(['standard', 'relaxed']).default('standard'),
  })
  .superRefine((value, ctx) => {
    if (value.base_url != null && value.base_url !== '' && !credentialFreeHttpUrl(value.base_url)) {
      ctx.addIssue({ code: 'custom', path: ['base_url'], message: 'base_url must be an absolute HTTP(S) URL without credentials, query, or fragment' });
    }
    if (value.no_api_key && value.api_key) {
      ctx.addIssue({ code: 'custom', path: ['api_key'], message: 'api_key must be empty when no_api_key is enabled' });
    }
  })
  .transform((value) => ({
    ...value,
    provider: value.provider.trim(),
    model_name: value.model_name.trim(),
    base_url: value.base_url?.trim().replace(/\/+$/, '') || null,
  }))
  .pipe(z.object({
    provider: z.string().min(2).max(50),
    model_name: z.string().min(1).max(200),
    base_url: z.string().max(2_000).nullable(),
    api_key: z.string().max(4_096).nullable(),
    no_api_key: z.boolean(),
    compatibility_mode: z.enum(['standard', 'relaxed']),
  }));

export const AvailableModelsRequestSchema = z.object({
  provider: z.string().min(2).max(50),
  base_url: z.string().max(2_000).nullable().default(null),
  api_key: z.string().nullable().default(null),
  no_api_key: z.boolean().default(false),
});

export const ModelProviderPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  base_url: z.string(),
  default_model: z.string(),
  suggested_models: z.array(z.string()).default([]),
  requires_api_key: z.boolean().default(true),
  api_key_env: nullableText.default(null),
  note: z.string().default(''),
});
export const ModelStatusSchema = z.object({
  mode: z.string(),
  configured: z.boolean(),
  provider: nullableText.default(null),
  provider_name: nullableText.default(null),
  model_name: nullableText.default(null),
  base_url: nullableText.default(null),
  api_key_configured: z.boolean().default(false),
  source: nullableText.default(null),
  compatibility_mode: z.string().default('standard'),
});
export const ModelConnectionResultSchema = z.object({
  ok: z.boolean(),
  provider: z.string(),
  model_name: z.string(),
  latency_ms: z.number().int(),
  response_preview: z.string(),
});

export const RepositoryRecordSchema = z.object({
  id: z.string().default(() => `repo-${randomUUID().replaceAll('-', '').slice(0, 10)}`),
  name: z.string(),
  url: z.string(),
  // Kept as the persisted ref field for database compatibility. Active source
  // selection comes only from version-registry, never from this value.
  default_branch: z.string(),
  created_at: isoDateTime.default(nowIsoDateTime),
  updated_at: isoDateTime.default(nowIsoDateTime),
});
export const RepositorySnapshotSchema = z.object({
  repository_id: z.string(),
  repository_name: z.string(),
  requested_ref: z.string(),
  resolved_commit: z.string(),
  workspace_path: z.string(),
  source: z.enum(['git', 'gitlab-api-archive']).optional(),
  created_at: isoDateTime.default(nowIsoDateTime),
});

export const SkillSummarySchema = z.object({
  name: z.string(), description: z.string(), version: z.string(), stage: z.string(),
});
export const MetaResponseSchema = z.object({
  mode: z.string(),
  model: nullableText,
  skills: z.array(SkillSummarySchema),
  mcp_tools: z.array(z.string()),
  constraints: z.array(z.string()),
  context_windows: z.record(z.string(), z.number().int()).default({}),
  model_prices: z.record(z.string(), z.strictObject({ input: z.number(), output: z.number() })).default({}),
});
export const HealthResponseSchema = z.object({
  status: z.string(), mode: z.string(), model: nullableText, provider: nullableText,
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type SourceSnapshotIdentity = z.infer<typeof SourceSnapshotIdentitySchema>;
export type SourceObservationContext = z.infer<typeof SourceObservationContextSchema>;
export type Responsibility = z.infer<typeof ResponsibilitySchema>;
export type DiagnosisTaskType = z.infer<typeof DiagnosisTaskTypeSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type RemoteConclusion = z.infer<typeof RemoteConclusionSchema>;
export type VerifiedClaim = z.infer<typeof VerifiedClaimSchema>;
export type JointAssessment = z.infer<typeof JointAssessmentSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;
export type RootCauseCandidate = z.infer<typeof RootCauseCandidateSchema>;
export type DiagnosisReport = z.infer<typeof DiagnosisReportSchema>;
export type DiagnosisReportDraft = z.infer<typeof DiagnosisReportDraftSchema>;
export type ToolEvent = z.infer<typeof ToolEventSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ExternalConsultation = z.infer<typeof ExternalConsultationSchema>;
export type SlotAudit = z.infer<typeof SlotAuditSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
export type CompareSourceBinding = z.infer<typeof CompareSourceBindingSchema>;
export type ModelConfigRequest = z.infer<typeof ModelConfigRequestSchema>;
export type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;
export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;
export type ClientProductLine = z.infer<typeof ClientProductLineSchema>;
export type ClientFormFactor = z.infer<typeof ClientFormFactorSchema>;
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
export type SourceRepositoryBinding = z.infer<typeof SourceRepositoryBindingSchema>;
export type SourceCompleteness = z.infer<typeof SourceCompletenessSchema>;
