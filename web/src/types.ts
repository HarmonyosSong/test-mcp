export interface RootCauseCandidate {
  title: string;
  explanation: string;
  confidence: number;
  evidence_ids: string[];
}

export interface ReportEvidence {
  id: string;
  kind: 'user' | 'log' | 'source' | 'config' | 'tool';
  source: string;
  location?: string | null;
  excerpt: string;
  supports: string;
}

export interface ToolEvent {
  id: string;
  tool: string;
  status: string;
  summary: string;
  arguments_summary?: string | null;
  result_summary?: string | null;
  duration_ms?: number | null;
  created_at: string;
}

export type ChatStep = ToolEvent;

export type ChatMessageStatus = 'streaming' | 'completed' | 'failed';

export type Responsibility = 'client' | 'server' | 'shared' | 'unknown';

export interface RemoteConclusion {
  consultation_id: string;
  task_id: string | null;
  context_id: string | null;
  agent_id: string | null;
  agent_version: string | null;
  state: string | null;
  text: string;
  truncated: boolean;
  scope: string[];
  limitations: string[];
  request_digest: string;
  received_at: string;
}

export interface JointAssessment {
  relation: 'corroborated' | 'conflicting' | 'unverified';
  text: string;
  verified_claims: Array<{ claim: string; evidence_ids: string[] }>;
  unverified_claims: string[];
  next_actions: string[];
}

export interface DiagnosticReport {
  verdict: 'located' | 'probable' | 'insufficient_evidence' | 'tool_error';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  summary: string;
  issue_category: string;
  task_type?: 'rule' | 'implementation' | 'incident' | 'unknown';
  confidence: number;
  likely_location?: string | null;
  root_cause_candidates: RootCauseCandidate[];
  evidence: ReportEvidence[];
  ruled_out: string[];
  missing_information: string[];
  checks_performed: string[];
  limitations: string[];
  responsibility?: Responsibility;
  remote_conclusion?: RemoteConclusion | null;
  external_findings?: RemoteConclusion[];
  joint_assessment?: JointAssessment | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps: ChatStep[];
  status: ChatMessageStatus;
  error?: string | null;
  report?: DiagnosticReport | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  created_at: string;
}

export type RunState =
  | 'idle'
  | 'running'
  | 'waiting_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ConsultationStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'sent'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'unknown'
  | 'expired';

export interface ExternalConsultation {
  id: string;
  conversation_id?: string;
  message_id?: string;
  run_id?: string;
  status: ConsultationStatus;
  reason: string;
  outbound_text: string;
  outbound_digest: string;
  redaction_version?: string;
  attachment_items?: string[];
  expires_at: string;
  task_id?: string | null;
  context_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvestigationPlan {
  mode: 'local' | 'server' | 'parallel';
  branches: Array<'client' | 'server'>;
  reason: string;
  remoteSlots?: string[];
  clientSteps?: Array<'observe' | 'source'>;
  correlationReady?: boolean;
  budget?: { maxSeconds: number; maxRemoteCalls: number };
  maxHandoffRounds?: number;
}

export interface InvestigationState {
  currentPlan?: InvestigationPlan;
  initialPlan?: InvestigationPlan;
  planHistory?: InvestigationPlan[];
  [key: string]: unknown;
}

export interface ConsultationAction {
  consultationId: string;
  decision: 'approve' | 'reject';
}

export interface ChatConversation {
  id: string;
  title: string;
  workspace_path?: string | null;
  repository_id?: string | null;
  repository_name?: string | null;
  requested_ref?: string | null;
  resolved_commit?: string | null;
  model_override?: string | null;
  run_state?: RunState;
  consult_compass?: boolean;
  consultations?: ExternalConsultation[];
  external_findings?: RemoteConclusion[];
  investigation?: InvestigationState | null;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  repository_name?: string | null;
  message_count: number;
  updated_at: string;
}

export interface CreateConversationInput {
  title?: string;
  workspace_path?: string;
  repository_id?: string;
  branch?: string;
}

export interface HealthResponse {
  status: string;
  mode: string;
  model: string | null;
  provider: string | null;
}

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  stage: string;
}

export interface MetaResponse {
  mode: string;
  model: string | null;
  skills: SkillMeta[];
  mcp_tools: string[];
  constraints: string[];
  context_windows: Record<string, number>;
  model_prices: Record<string, { input: number; output: number }>;
}

export interface RepositoryVersionMapping {
  branch: string;
  expected_commit: string;
}

export interface RepositoryRecord {
  id: string;
  name: string;
  url: string;
  default_branch: string;
  platform: 'harmony' | 'android' | 'ios' | null;
  version_map: Record<string, RepositoryVersionMapping>;
  created_at: string;
  updated_at: string;
}

export interface RepositoryBranch {
  name: string;
  commit: string;
}

export interface RegisterRepositoryInput {
  name: string;
  url: string;
  default_branch?: string;
  platform?: 'harmony' | 'android' | 'ios' | null;
  version_map?: Record<string, RepositoryVersionMapping>;
}

export interface RepositorySnapshot {
  repository_id: string;
  repository_name: string;
  requested_ref: string;
  resolved_commit: string;
  workspace_path: string;
  created_at: string;
}

export interface ModelProviderPreset {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  suggested_models: string[];
  requires_api_key: boolean;
  api_key_env?: string | null;
  note: string;
}

export interface ModelStatus {
  mode: 'demo' | 'model';
  configured: boolean;
  provider?: string | null;
  provider_name?: string | null;
  model_name?: string | null;
  base_url?: string | null;
  api_key_configured: boolean;
  source?: string | null;
  compatibility_mode: 'standard' | 'relaxed';
}

export interface ModelConfigInput {
  provider: string;
  model_name: string;
  base_url?: string;
  api_key?: string;
  no_api_key: boolean;
  compatibility_mode: 'standard' | 'relaxed';
}

export interface ModelConnectionResult {
  ok: boolean;
  provider: string;
  model_name: string;
  latency_ms: number;
  response_preview: string;
}

export type ConnectionState = 'checking' | 'connected' | 'demo';
