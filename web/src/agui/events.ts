import type {
  ChatConversation,
  ExternalConsultation,
  InvestigationPlan,
  JointAssessment,
  Responsibility,
  ToolEvent,
} from '../types';

export const AGUI_EVENT_TYPES = [
  'RUN_STARTED',
  'TOOL_CALL_START',
  'TOOL_CALL_END',
  'STATE_SNAPSHOT',
  'RUN_FINISHED',
  'RUN_ERROR',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'INVESTIGATION_PLAN',
  'BRANCH_STATUS',
  'EXTERNAL_CONSULTATION_REQUIRED',
  'JOINT_ASSESSMENT',
] as const;

export type AguiEventType = (typeof AGUI_EVENT_TYPES)[number];

interface AguiEventBase {
  type: AguiEventType;
  run_id: string;
  timestamp: string;
}

export interface RunStartedEvent extends AguiEventBase {
  type: 'RUN_STARTED';
  conversation_id?: string;
  conversation?: ChatConversation;
}

export interface ToolCallStartEvent extends AguiEventBase {
  type: 'TOOL_CALL_START';
  message_id?: string;
  tool_event: ToolEvent;
}

export interface ToolCallEndEvent extends AguiEventBase {
  type: 'TOOL_CALL_END';
  message_id?: string;
  tool_event: ToolEvent;
}

export interface StateSnapshotEvent extends AguiEventBase {
  type: 'STATE_SNAPSHOT';
  conversation_id?: string;
  conversation?: ChatConversation;
}

export interface RunFinishedEvent extends AguiEventBase {
  type: 'RUN_FINISHED';
  conversation_id?: string;
  conversation?: ChatConversation;
}

export interface RunErrorEvent extends AguiEventBase {
  type: 'RUN_ERROR';
  conversation_id?: string;
  message_id?: string;
  error: string;
  failure_category?: 'cancelled' | 'provider_error' | 'tool_protocol_error' | 'runtime_error';
  conversation?: ChatConversation;
}

export interface TextMessageStartEvent extends AguiEventBase {
  type: 'TEXT_MESSAGE_START';
  message_id: string;
}

export interface TextMessageContentEvent extends AguiEventBase {
  type: 'TEXT_MESSAGE_CONTENT';
  message_id: string;
  delta: string;
}

export interface TextMessageEndEvent extends AguiEventBase {
  type: 'TEXT_MESSAGE_END';
  message_id: string;
}

export interface InvestigationPlanEvent extends AguiEventBase {
  type: 'INVESTIGATION_PLAN';
  plan?: InvestigationPlan;
  mode?: InvestigationPlan['mode'];
  branches?: InvestigationPlan['branches'];
  reason?: string;
  resumed?: boolean;
}

export interface BranchStatusEvent extends AguiEventBase {
  type: 'BRANCH_STATUS';
  branch: 'client' | 'server';
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  summary?: string;
}

export interface ExternalConsultationRequiredEvent extends AguiEventBase {
  type: 'EXTERNAL_CONSULTATION_REQUIRED';
  consultation?: ExternalConsultation;
  consultation_id?: string;
}

export interface JointAssessmentEvent extends AguiEventBase {
  type: 'JOINT_ASSESSMENT';
  responsibility: Responsibility;
  assessment?: JointAssessment | null;
}

export type AguiEvent =
  | RunStartedEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | StateSnapshotEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | InvestigationPlanEvent
  | BranchStatusEvent
  | ExternalConsultationRequiredEvent
  | JointAssessmentEvent;

const EVENT_TYPE_SET = new Set<string>(AGUI_EVENT_TYPES);

export function isAguiEvent(value: unknown): value is AguiEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && EVENT_TYPE_SET.has(type);
}

/** 解码单个 SSE 块；合法但尚未支持的事件类型由旧前端静默忽略。 */
export function decodeAguiEventBlock(block: string): AguiEvent | null {
  let namedType = '';
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') namedType = value;
    if (field === 'data') dataLines.push(value);
  }

  if (!dataLines.length) return null;
  const parsed: unknown = JSON.parse(dataLines.join('\n'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('服务返回了无法识别的 AG-UI 事件');
  }

  const candidate = parsed as { type?: unknown };
  if (!candidate.type && namedType) candidate.type = namedType;
  if (typeof candidate.type === 'string' && !EVENT_TYPE_SET.has(candidate.type)) {
    return null;
  }
  if (!isAguiEvent(candidate)) {
    throw new Error('服务返回了无法识别的 AG-UI 事件');
  }
  return candidate;
}
