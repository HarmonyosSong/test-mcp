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
  verdict: 'located' | 'probable' | 'insufficient_evidence' | 'tool_error' | 'info_lookup';
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

// waiting_confirmation 随人工审批流退役；历史数据由服务端启动修复为 failed。
export type RunState =
  | 'idle'
  | 'running'
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

export interface ChatConversation {
  id: string;
  title: string;
  repository_name?: string | null;
  requested_ref?: string | null;
  resolved_commit?: string | null;
  source_repositories?: Array<{
    repository_id: string;
    repository_name: string;
    requested_ref: string;
    resolved_commit: string;
    role: 'shell' | 'component' | 'config';
    mount_path: string;
  }>;
  source_completeness?: 'complete' | 'partial' | 'unknown' | null;
  source_limitations?: string[];
  platform?: 'harmony' | 'android' | 'ios' | null;
  product_line?: 'xueersi' | 'xuejiayun' | null;
  form_factor?: 'phone' | 'pad' | 'universal' | null;
  version?: string | null;
  build?: string | null;
  model_override?: string | null;
  run_state?: RunState;
  consultations?: ExternalConsultation[];
  external_findings?: RemoteConclusion[];
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  repository_name?: string | null;
  /** 渠道：web=工作台创建；yach_im=知音楼接入（同步展示便于排查 IM 侧问题）。 */
  channel?: 'web' | 'yach_im';
  message_count: number;
  updated_at: string;
}

export interface CreateConversationInput {
  title?: string;
}

/** 调试面板：一轮诊断的 AI trace 摘要（manifest 行），或一条会话时间线事件。 */
export interface AiTraceSummary {
  ts: string;
  trace_id: string;
  message_id: string | null;
  /** trace = 模型轮；event = 编排事实（协查发起/回执/分析轮跳过等）。旧服务端缺省视为 trace。 */
  entry_type?: 'trace' | 'event';
  /** event 条目的事件种类（compass_followup_sent 等）。 */
  event_kind?: string;
  /** event 条目的一行标题。 */
  title?: string;
  summary?: {
    duration_ms?: number | null;
    steps?: number;
    tool_calls?: number;
  };
}

export interface AiTraceTool {
  name: string;
  kind: 'tool' | 'mcp_tool';
  duration_ms: number | null;
  /** schema v2 起落盘的执行窗口（ISO 时间串）；旧 trace 可能缺失。 */
  started_at?: string | null;
  ended_at?: string | null;
  success: boolean | null;
  input_preview?: string;
  output_preview?: string;
  error?: string;
}

export interface AiTraceStepUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputDetails?: { cacheRead?: number; text?: number };
  outputDetails?: { reasoning?: number; text?: number };
}

export interface AiTraceStep {
  step_index: number;
  duration_ms: number | null;
  /** schema v2 起落盘的模型调用窗口（ISO 时间串）；旧 trace 可能缺失。 */
  started_at?: string | null;
  ended_at?: string | null;
  model_text?: string;
  /** 推理（thinking）文本：模型产出 reasoning 时才有；非推理模型缺省。 */
  thinking_text?: string;
  finish_reason?: string;
  time_to_first_token_ms?: number | null;
  usage?: AiTraceStepUsage;
  tools: AiTraceTool[];
}

/** 调试面板：一轮诊断的完整 AI trace。 */
export interface AiTraceDetail {
  conversation_id: string;
  message_id: string | null;
  trace_id: string;
  captured_at: string;
  /** schema v2 起落盘的本轮开始时间（ISO 时间串）；旧 trace 可能缺失。 */
  started_at?: string | null;
  model: string | null;
  user_input?: string;
  final_answer?: string;
  steps: AiTraceStep[];
  orphan_tools?: AiTraceTool[];
}

/** 调试面板：一条会话时间线事件的详情（协查发起/回执、分析轮跳过等编排事实）。 */
export interface AiTimelineEventDetail {
  entry_type: 'event';
  conversation_id: string;
  trace_id: string;
  captured_at: string;
  event_id: string;
  kind: string;
  at: string;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

/** ai-traces/:id 的返回：模型轮 trace 或时间线事件。 */
export type AiTraceOrEventDetail =
  | (AiTraceDetail & { entry_type?: 'trace' })
  | AiTimelineEventDetail;

export function isTimelineEventDetail(detail: AiTraceOrEventDetail): detail is AiTimelineEventDetail {
  return (detail as AiTimelineEventDetail).entry_type === 'event';
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
