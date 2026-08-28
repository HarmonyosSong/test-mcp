export type CaseStatus = 'queued' | 'running' | 'completed' | 'failed';

export type DiagnosticStageKey =
  | 'intake'
  | 'locate'
  | 'investigate'
  | 'diagnose';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DiagnosticStage {
  key: DiagnosticStageKey;
  label: string;
  status: StageStatus;
  summary: string;
  started_at?: string | null;
  completed_at?: string | null;
}

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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps: ChatStep[];
  status: ChatMessageStatus;
  error?: string | null;
  case_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  created_at: string;
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
  messages: ChatMessage[];
  case_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  repository_name?: string | null;
  message_count: number;
  case_ids: string[];
  updated_at: string;
}

export interface CreateConversationInput {
  title?: string;
  workspace_path?: string;
  repository_id?: string;
  branch?: string;
}

export type CaseDraft = CreateCaseInput;

export interface DiagnosticReport {
  verdict: 'located' | 'probable' | 'insufficient_evidence' | 'tool_error';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  summary: string;
  issue_category: string;
  confidence: number;
  likely_location?: string | null;
  root_cause_candidates: RootCauseCandidate[];
  evidence: ReportEvidence[];
  ruled_out: string[];
  missing_information: string[];
  checks_performed: string[];
  limitations: string[];
}

export interface DiagnosticCase {
  id: string;
  title: string;
  description: string;
  input_evidence: string;
  workspace_path?: string | null;
  repository_id?: string | null;
  repository_name?: string | null;
  requested_ref?: string | null;
  resolved_commit?: string | null;
  status: CaseStatus;
  created_at: string;
  updated_at: string;
  stages: DiagnosticStage[];
  tool_events: ToolEvent[];
  report?: DiagnosticReport | null;
  error?: string | null;
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

export interface CreateCaseInput {
  title: string;
  description: string;
  evidence: string;
  workspace_path?: string;
  repository_id?: string;
  branch?: string;
}

export interface RepositoryRecord {
  id: string;
  name: string;
  url: string;
  default_branch: string;
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
export type DetailView = 'process' | 'diagnosis';
export type MobileView = 'cases' | DetailView;
