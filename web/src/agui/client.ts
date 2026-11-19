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

  // 终态事件即让调用方继续（输入框解锁）；流保持后台读取，
  // 服务端可能在终态后补推后台协查结果（STATE_SNAPSHOT）。
  return await new Promise<TState>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      if (current) resolvePromise(current);
      else rejectPromise(new AguiUnavailableError('AG-UI 事件流为空'));
    };
    const finishErr = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    const consume = (block: string) => {
      const event = decodeAguiEventBlock(block);
      if (!event) return;
      receivedEvent = true;
      current = options.reduce(current, event);
      options.onEvent?.(event, current);
      if (event.type === 'RUN_ERROR') {
        finishErr(new AguiRunError(event.error, current));
        return;
      }
      if (event.type === 'RUN_FINISHED') finishOk();
    };

    (async () => {
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
        finishOk();
      } catch (error) {
        if (!receivedEvent) {
          const message = error instanceof Error ? error.message : 'AG-UI 事件流读取失败';
          finishErr(new AguiUnavailableError(message));
        } else if (!settled) {
          finishErr(error);
        }
        // 已按终态收尾后，后台补推阶段的读取失败静默忽略。
      } finally {
        reader.releaseLock();
      }
    })();
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
    apiPath(`/conversations/${conversationId}/messages`),
    { content },
    {
      signal: options.signal,
      onEvent: options.onEvent,
      reduce: reduceChatEvent,
    },
  );
}
