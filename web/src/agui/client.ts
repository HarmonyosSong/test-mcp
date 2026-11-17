import { apiPath } from '../auth/paths';
import { authenticatedFetch } from '../auth/session-fetch';
import type { ChatConversation } from '../types';
import { reduceChatEvent } from './chatReducer';
import { decodeAguiEventBlock, type AguiEvent } from './events';

export class AguiUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
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
    response = await authenticatedFetch(url, {
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
    throw new AguiUnavailableError(message, response.status);
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
    const event = decodeAguiEventBlock(block);
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

export async function streamChatMessage(
  conversationId: string,
  content: string,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: AguiEvent, conversation: ChatConversation | null) => void;
  } = {},
): Promise<ChatConversation> {
  return readEventStream<ChatConversation>(
    apiPath(`/conversations/${conversationId}/messages`),
    { content },
    {
      signal: options.signal,
      onEvent: options.onEvent,
      reduce: reduceChatEvent,
    },
  );
}
