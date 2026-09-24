import type { ChatConversation, ToolEvent } from '../types';

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

export type AguiEvent =
  | RunStartedEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | StateSnapshotEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent;

const EVENT_TYPE_SET = new Set<string>(AGUI_EVENT_TYPES);

export function isAguiEvent(value: unknown): value is AguiEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && EVENT_TYPE_SET.has(type);
}
