import type { ChatConversation, CreateCaseInput, DiagnosticCase } from '../types';
import { reduceChatEvent } from './chatReducer';
import { isAguiEvent, type AguiEvent, type AguiEventType } from './events';
import { reduceAguiEvent } from './reducer';

const API_BASE = (import.meta.env.VITE_API_BASE || '/harmonyos_agent').replace(/\/$/, '');

export class AguiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AguiUnavailableError';
  }
}

export class AguiRunError<TState> extends Error {
  constructor(
    message: string,
    readonly state: TState | null,
  ) {
    super(message);
    this.name = 'AguiRunError';
  }
}

function decodeEventBlock(block: string): AguiEvent | null {
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
  const parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  if (!parsed.type && namedType) parsed.type = namedType as AguiEventType;
  if (!isAguiEvent(parsed)) {
    throw new Error('服务返回了无法识别的 AG-UI 事件');
  }
  return parsed;
}

interface EventStreamOptions<TState> {
  signal?: AbortSignal;
  onEvent?: (event: AguiEvent, state: TState | null) => void;
  reduce: (state: TState | null, event: AguiEvent) => TState | null;
}

/** 通用的 AG-UI SSE 读流：建立连接、逐块解析事件、驱动 reducer。 */
async function readEventStream<TState>(
  url: string,
  body: unknown,
  options: EventStreamOptions<TState>,
): Promise<TState> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法连接 AG-UI 服务';
    throw new AguiUnavailableError(message);
  }

  if (!response.ok) {
    let message = `AG-UI 请求失败 (${response.status})`;
    try {
      const bodyJson = (await response.json()) as { detail?: string; message?: string };
      message = bodyJson.detail || bodyJson.message || message;
    } catch {
      // The status remains actionable when the response has no JSON body.
    }
    throw new AguiUnavailableError(message);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/event-stream') || !response.body) {
    throw new AguiUnavailableError('服务未返回 AG-UI 事件流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: TState | null = null;
  let receivedEvent = false;

  const consume = (block: string) => {
    const event = decodeEventBlock(block);
    if (!event) return;
    receivedEvent = true;
    current = options.reduce(current, event);
    options.onEvent?.(event, current);
    if (event.type === 'RUN_ERROR') {
      throw new AguiRunError(event.error, current);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      blocks.forEach(consume);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (error instanceof AguiRunError) throw error;
    if (!receivedEvent) {
      const message = error instanceof Error ? error.message : 'AG-UI 事件流读取失败';
      throw new AguiUnavailableError(message);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!current) throw new AguiUnavailableError('AG-UI 事件流为空');
  return current;
}

export async function streamDiagnosis(
  input: CreateCaseInput,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: AguiEvent, diagnosticCase: DiagnosticCase | null) => void;
  } = {},
): Promise<DiagnosticCase> {
  return readEventStream<DiagnosticCase>(`${API_BASE}/api/agui/runs`, input, {
    signal: options.signal,
    onEvent: options.onEvent,
    reduce: reduceAguiEvent,
  });
}

export async function streamChatMessage(
  conversationId: string,
  content: string,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: AguiEvent, conversation: ChatConversation | null) => void;
  } = {},
): Promise<ChatConversation> {
  return readEventStream<ChatConversation>(
    `${API_BASE}/api/conversations/${conversationId}/messages`,
    { content },
    {
      signal: options.signal,
      onEvent: options.onEvent,
      reduce: reduceChatEvent,
    },
  );
}
