import { randomUUID } from 'node:crypto';

/** Protocol constants (not environment defaults — those live in `config.ts` / `.env.example`). */
export const COMPASS_A2A_PROTOCOL_VERSION = '1.0';
export const COMPASS_A2A_RPC_PATH = '/compass/a2a';
export const COMPASS_A2A_AGENT_CARD_PATH = '/compass/.well-known/agent-card.json';

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_CANCELLED',
  'TASK_STATE_REJECTED',
]);

export type CompassA2AConfig = {
  baseUrl: string;
  clientId: string;
  token: string;
  waitSeconds: number;
  fetch?: typeof fetch;
};

export type CompassA2AInterface = {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
};

export type CompassA2AAgentCard = {
  name?: string;
  description?: string;
  version?: string;
  capabilities?: { streaming?: boolean };
  supportedInterfaces: CompassA2AInterface[];
  raw: Record<string, unknown>;
};

export type CompassA2AProgress = {
  kind: 'status' | 'artifact' | 'task';
  state?: string;
  summary: string;
  taskId?: string;
  contextId?: string;
};

export type CompassA2AResult = {
  text: string;
  taskId: string | null;
  contextId: string | null;
  state: string | null;
};

export class CompassA2AError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = 'CompassA2AError';
  }
}

export function isCompassA2AConfigured(token: string | undefined | null): boolean {
  return Boolean(token?.trim());
}

export function normalizeCompassA2ABaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new CompassA2AError('A2A base URL is required');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CompassA2AError(`Invalid A2A base URL: ${baseUrl}`);
  }
  if (url.username || url.password) {
    throw new CompassA2AError('A2A base URL must not include credentials');
  }
  if (url.search || url.hash) {
    throw new CompassA2AError('A2A base URL must not include query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '') || '';
  if (path && path !== '') {
    throw new CompassA2AError('A2A base URL must be origin only (no path such as /compass)');
  }
  return url.origin;
}

function authHeaders(config: CompassA2AConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token.trim()}`,
    'A2A-Version': COMPASS_A2A_PROTOCOL_VERSION,
    'X-A2A-Client-Id': config.clientId.trim(),
  };
}

function extractTextParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.trim()) texts.push(record.text);
  }
  return texts;
}

function stateOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const state = (status as Record<string, unknown>).state;
  return typeof state === 'string' ? state : null;
}

function parseJsonRpcPayload(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CompassA2AError('Compass A2A returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CompassA2AError('Compass A2A returned a non-object JSON payload');
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)) {
    const error = payload.error as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : 'Compass A2A request failed';
    throw new CompassA2AError(message, typeof error.code === 'number' ? error.code : undefined);
  }
  return payload;
}

async function* iterateSseDataLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new CompassA2AError('Compass A2A request aborted', 'aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      while (true) {
        const separator = buffer.indexOf('\n\n');
        if (separator < 0) break;
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') yield data;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.replace(/\r\n/g, '\n').split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class CompassA2AClient {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly token: string;
  readonly waitSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private rpcUrl: string | null = null;

  constructor(config: CompassA2AConfig) {
    if (!isCompassA2AConfigured(config.token)) {
      throw new CompassA2AError('Compass A2A token is not configured');
    }
    const clientId = config.clientId.trim();
    if (!clientId) throw new CompassA2AError('Compass A2A client id is required');
    if (config.waitSeconds === undefined) {
      throw new CompassA2AError('Compass A2A waitSeconds is required (pass runtime config)');
    }
    this.baseUrl = normalizeCompassA2ABaseUrl(config.baseUrl);
    this.clientId = clientId;
    this.token = config.token.trim();
    this.waitSeconds = config.waitSeconds;
    if (!Number.isFinite(this.waitSeconds) || this.waitSeconds < 1) {
      throw new CompassA2AError('A2A waitSeconds must be a positive number');
    }
    this.fetchImpl = config.fetch ?? fetch;
  }

  async fetchAgentCard(signal?: AbortSignal): Promise<CompassA2AAgentCard> {
    const response = await this.fetchImpl(new URL(COMPASS_A2A_AGENT_CARD_PATH, `${this.baseUrl}/`).toString(), {
      method: 'GET',
      headers: authHeaders(this),
      signal,
    });
    if (!response.ok) {
      throw new CompassA2AError(`Failed to fetch Compass agent card (${response.status})`, response.status);
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const interfaces = Array.isArray(raw.supportedInterfaces) ? raw.supportedInterfaces : [];
    const supportedInterfaces: CompassA2AInterface[] = [];
    for (const item of interfaces) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record.url === 'string' &&
        typeof record.protocolBinding === 'string' &&
        typeof record.protocolVersion === 'string'
      ) {
        supportedInterfaces.push({
          url: record.url,
          protocolBinding: record.protocolBinding,
          protocolVersion: record.protocolVersion,
        });
      }
    }
    const selected = supportedInterfaces.find(
      (item) =>
        item.protocolBinding === 'JSONRPC' &&
        item.protocolVersion === COMPASS_A2A_PROTOCOL_VERSION,
    );
    if (!selected) {
      throw new CompassA2AError('Compass agent card has no JSON-RPC 1.0 interface');
    }
    let selectedUrl: URL;
    try {
      selectedUrl = new URL(selected.url);
    } catch {
      throw new CompassA2AError(`Compass agent card interface URL is invalid: ${selected.url}`);
    }
    if (selectedUrl.origin !== this.baseUrl) {
      throw new CompassA2AError('Compass A2A RPC origin must match configured base URL');
    }
    if (selectedUrl.pathname.replace(/\/+$/, '') !== COMPASS_A2A_RPC_PATH) {
      throw new CompassA2AError(`Compass A2A RPC path must be ${COMPASS_A2A_RPC_PATH}`);
    }
    this.rpcUrl = selectedUrl.toString();
    return {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      capabilities:
        raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities)
          ? { streaming: Boolean((raw.capabilities as Record<string, unknown>).streaming) }
          : undefined,
      supportedInterfaces,
      raw,
    };
  }

  async ensureRpcUrl(signal?: AbortSignal): Promise<string> {
    if (this.rpcUrl) return this.rpcUrl;
    await this.fetchAgentCard(signal);
    if (!this.rpcUrl) throw new CompassA2AError('Compass A2A RPC URL unavailable');
    return this.rpcUrl;
  }

  async sendStreamingMessage(input: {
    text: string;
    contextId?: string;
    messageId?: string;
    onProgress?: (progress: CompassA2AProgress) => void;
    abortSignal?: AbortSignal;
  }): Promise<CompassA2AResult> {
    const text = input.text.trim();
    if (!text) throw new CompassA2AError('Compass A2A message text is required');
    const rpcUrl = await this.ensureRpcUrl(input.abortSignal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.waitSeconds * 1000);
    const onAbort = () => controller.abort();
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const message: Record<string, unknown> = {
        role: 'ROLE_USER',
        parts: [{ text }],
        messageId: input.messageId?.trim() || randomUUID(),
      };
      if (input.contextId?.trim()) message.contextId = input.contextId.trim();
      const response = await this.fetchImpl(rpcUrl, {
        method: 'POST',
        headers: {
          ...authHeaders(this),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'SendStreamingMessage',
          params: { message },
        }),
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        throw new CompassA2AError(`Compass A2A stream failed (${response.status})`, response.status);
      }
      if (!contentType.includes('text/event-stream')) {
        parseJsonRpcPayload(await response.text());
        throw new CompassA2AError('Compass A2A did not return an event stream', 'non_stream');
      }
      if (!response.body) throw new CompassA2AError('Compass A2A stream body is empty');

      let taskId: string | null = null;
      let contextId: string | null = input.contextId?.trim() || null;
      let state: string | null = null;
      const artifactTexts: string[] = [];

      for await (const data of iterateSseDataLines(response.body, controller.signal)) {
        const payload = parseJsonRpcPayload(data);
        const result = payload.result;
        if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
        const record = result as Record<string, unknown>;

        if (record.task && typeof record.task === 'object' && !Array.isArray(record.task)) {
          const task = record.task as Record<string, unknown>;
          if (typeof task.id === 'string') taskId = task.id;
          if (typeof task.contextId === 'string') contextId = task.contextId;
          state = stateOf(task) ?? state;
          input.onProgress?.({
            kind: 'task',
            state: state ?? undefined,
            summary: state ? `Compass 任务 ${state}` : 'Compass 任务已创建',
            taskId: taskId ?? undefined,
            contextId: contextId ?? undefined,
          });
        }

        if (record.artifactUpdate && typeof record.artifactUpdate === 'object' && !Array.isArray(record.artifactUpdate)) {
          const update = record.artifactUpdate as Record<string, unknown>;
          if (typeof update.taskId === 'string') taskId = update.taskId;
          if (typeof update.contextId === 'string') contextId = update.contextId;
          const artifact = update.artifact;
          if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
            const parts = extractTextParts((artifact as Record<string, unknown>).parts);
            artifactTexts.push(...parts);
            const name =
              typeof (artifact as Record<string, unknown>).name === 'string'
                ? ((artifact as Record<string, unknown>).name as string)
                : 'artifact';
            input.onProgress?.({
              kind: 'artifact',
              state: state ?? undefined,
              summary: parts[0] ? `${name}: ${parts[0].slice(0, 200)}` : `收到 ${name}`,
              taskId: taskId ?? undefined,
              contextId: contextId ?? undefined,
            });
          }
        }

        if (record.statusUpdate && typeof record.statusUpdate === 'object' && !Array.isArray(record.statusUpdate)) {
          const update = record.statusUpdate as Record<string, unknown>;
          if (typeof update.taskId === 'string') taskId = update.taskId;
          if (typeof update.contextId === 'string') contextId = update.contextId;
          state = stateOf(update) ?? state;
          input.onProgress?.({
            kind: 'status',
            state: state ?? undefined,
            summary: state ? `Compass 状态 ${state}` : 'Compass 状态更新',
            taskId: taskId ?? undefined,
            contextId: contextId ?? undefined,
          });
          if (state && TERMINAL_STATES.has(state)) break;
        }
      }

      const finalText = artifactTexts.join('\n').trim();
      if (!finalText && state && state !== 'TASK_STATE_COMPLETED') {
        throw new CompassA2AError(`Compass A2A ended in ${state}`, state);
      }
      if (!finalText) {
        throw new CompassA2AError('Compass A2A completed without text artifacts');
      }
      return { text: finalText, taskId, contextId, state };
    } catch (error) {
      if (error instanceof CompassA2AError) throw error;
      if (controller.signal.aborted) {
        throw new CompassA2AError(
          input.abortSignal?.aborted ? 'Compass A2A request aborted' : `Compass A2A timed out after ${this.waitSeconds}s`,
          input.abortSignal?.aborted ? 'aborted' : 'timeout',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
    const id = taskId.trim();
    if (!id) throw new CompassA2AError('Compass A2A task id is required');
    const rpcUrl = await this.ensureRpcUrl(signal);
    const response = await this.fetchImpl(rpcUrl, {
      method: 'POST',
      headers: {
        ...authHeaders(this),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'CancelTask',
        params: { id },
      }),
      signal,
    });
    if (!response.ok) {
      throw new CompassA2AError(`Compass A2A cancel failed (${response.status})`, response.status);
    }
    parseJsonRpcPayload(await response.text());
  }
}
