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

export const VerdictSchema = z.enum([
  'located',
  'probable',
  'insufficient_evidence',
  'tool_error',
]);
export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);
export const EvidenceKindSchema = z.enum(['user', 'log', 'source', 'config', 'tool']);
export const ChatMessageStatusSchema = z.enum(['streaming', 'completed', 'failed']);

export const EvidenceSchema = z.strictObject({
  id: z.string().default(defaultEvidenceId),
  kind: EvidenceKindSchema,
  source: z.string(),
  location: nullableText.default(null),
  excerpt: z.string().max(2_000),
  supports: z.string(),
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
  likely_location: nullableLocation.default(null),
  root_cause_candidates: z.array(RootCauseCandidateSchema).default([]),
  ruled_out: z.array(z.string()).default([]),
  missing_information: z.array(z.string()).default([]),
  checks_performed: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
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
  model_override: z.string().max(250).nullable().optional().default(null),
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

export const CreateConversationRequestSchema = z.object({
  title: z.string().trim().max(120).nullable().default(null).transform((value) => value || null),
  workspace_path: z.string().trim().max(2_000).nullable().default(null).transform((value) => value || null),
  repository_id: z.string().trim().max(100).nullable().default(null).transform((value) => value || null),
  branch: z.string().trim().max(500).nullable().default(null).transform((value) => value || null),
}).superRefine((value, ctx) => {
  if (Boolean(value.repository_id) !== Boolean(value.branch)) {
    ctx.addIssue({ code: 'custom', message: 'repository_id and branch must be provided together' });
  }
  if (value.workspace_path && value.repository_id) {
    ctx.addIssue({ code: 'custom', message: 'workspace_path and repository_id are mutually exclusive' });
  }
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

export const RegisterRepositoryRequestSchema = z.object({
  name: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  url: z.string().trim().min(8).max(2_000),
  default_branch: z.string().trim().max(500).nullable().default(null),
}).superRefine((value, ctx) => {
  const url = value.url.trim();
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch { /* SCP and file URLs are checked below. */ }
  if (parsed?.protocol === 'file:') {
    if (!parsed.pathname || parsed.hostname) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'local repository URL must contain an absolute local path' });
    }
    return;
  }
  if (parsed && ['http:', 'https:', 'ssh:'].includes(parsed.protocol)) {
    if (
      !parsed.hostname ||
      parsed.password ||
      (parsed.username && ['http:', 'https:'].includes(parsed.protocol)) ||
      /[?#]/.test(url)
    ) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'repository URL must include a host and must not contain credentials' });
    }
    return;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/.test(url)) return;
  ctx.addIssue({ code: 'custom', path: ['url'], message: 'repository URL must use HTTP(S), SSH, or SCP syntax' });
});

export const RepositoryRecordSchema = z.object({
  id: z.string().default(() => `repo-${randomUUID().replaceAll('-', '').slice(0, 10)}`),
  name: z.string(),
  url: z.string(),
  default_branch: z.string(),
  created_at: isoDateTime.default(nowIsoDateTime),
  updated_at: isoDateTime.default(nowIsoDateTime),
});
export const RepositoryBranchSchema = z.object({ name: z.string(), commit: z.string() });
export const CreateSnapshotRequestSchema = z.object({ branch: z.string().trim().min(1).max(500) });
export const RepositorySnapshotSchema = z.object({
  repository_id: z.string(),
  repository_name: z.string(),
  requested_ref: z.string(),
  resolved_commit: z.string(),
  workspace_path: z.string(),
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
export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;
export type RootCauseCandidate = z.infer<typeof RootCauseCandidateSchema>;
export type DiagnosisReport = z.infer<typeof DiagnosisReportSchema>;
export type DiagnosisReportDraft = z.infer<typeof DiagnosisReportDraftSchema>;
export type ToolEvent = z.infer<typeof ToolEventSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
export type ModelConfigRequest = z.infer<typeof ModelConfigRequestSchema>;
export type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;
export type RepositoryBranch = z.infer<typeof RepositoryBranchSchema>;
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
