/**
 * cloudlearn-devtools API MCP 的轻量 HTTP 客户端。
 * 仅供 Runtime 内部调用（窄工具封装），不把 api_* 暴露给模型。
 */

export type ApiMcpQueryResult = {
  api_id: string;
  data: unknown;
  truncated?: boolean;
  isError?: boolean;
  code?: string;
  message?: string;
};

export type ApiMcpClientOptions = {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

function parseMcpHttpBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as unknown;
  }
  // Streamable HTTP 可能返回 SSE：取最后一条 data JSON。
  let last: unknown = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    try {
      last = JSON.parse(data) as unknown;
    } catch {
      // ignore non-JSON data lines
    }
  }
  if (last == null) throw new Error('API MCP 响应不是合法 JSON/SSE');
  return last;
}

function unwrapToolResult(payload: unknown): ApiMcpQueryResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('API MCP 返回空结果');
  }
  const root = payload as Record<string, unknown>;
  if (root.error && typeof root.error === 'object') {
    const err = root.error as Record<string, unknown>;
    throw new Error(typeof err.message === 'string' ? err.message : 'API MCP JSON-RPC 错误');
  }
  const result = root.result ?? root;
  if (!result || typeof result !== 'object') {
    throw new Error('API MCP tools/call 缺少 result');
  }
  const body = result as Record<string, unknown>;
  const isError = body.isError === true;
  const structured = body.structuredContent;
  if (structured && typeof structured === 'object') {
    const data = structured as Record<string, unknown>;
    if (isError || data.code) {
      return {
        api_id: typeof data.api_id === 'string' ? data.api_id : '',
        data: null,
        isError: true,
        code: typeof data.code === 'string' ? data.code : 'API_ERROR',
        message: typeof data.message === 'string' ? data.message : 'API MCP 工具错误',
      };
    }
    return {
      api_id: typeof data.api_id === 'string' ? data.api_id : '',
      data: data.data,
      truncated: data.truncated === true,
    };
  }
  // 部分实现把业务 JSON 放在 content[].text
  const content = body.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text !== 'string' || !text.trim()) continue;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (isError || parsed.code) {
          return {
            api_id: typeof parsed.api_id === 'string' ? parsed.api_id : '',
            data: null,
            isError: true,
            code: typeof parsed.code === 'string' ? parsed.code : 'API_ERROR',
            message: typeof parsed.message === 'string' ? parsed.message : text,
          };
        }
        return {
          api_id: typeof parsed.api_id === 'string' ? parsed.api_id : '',
          data: parsed.data,
          truncated: parsed.truncated === true,
        };
      } catch {
        if (isError) {
          return { api_id: '', data: null, isError: true, code: 'API_ERROR', message: text };
        }
      }
    }
  }
  if (isError) {
    return { api_id: '', data: null, isError: true, code: 'API_ERROR', message: 'API MCP 工具错误' };
  }
  throw new Error('无法解析 API MCP 工具结果');
}

export class ApiMcpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly signal?: AbortSignal;
  private nextId = 1;
  private initialized = false;
  private protocolVersion = '2025-06-18';

  constructor(options: ApiMcpClientOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signal = options.signal;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
    };
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`API MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return parseMcpHttpBody(text);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const payload = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'troubleshoot-odyssey', version: '0.1.0' },
      },
    });
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    const result = root?.result && typeof root.result === 'object'
      ? root.result as Record<string, unknown>
      : null;
    if (typeof result?.protocolVersion === 'string' && result.protocolVersion.trim()) {
      this.protocolVersion = result.protocolVersion.trim();
    }
    await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    this.initialized = true;
  }

  async apiQuery(apiId: string, params: Record<string, unknown>): Promise<ApiMcpQueryResult> {
    await this.initialize();
    const payload = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: {
        name: 'api_query',
        arguments: { api_id: apiId, params },
      },
    });
    return unwrapToolResult(payload);
  }
}

export function apiMcpConfigured(config: { apiMcpUrl: string; apiMcpToken: string }): boolean {
  return Boolean(config.apiMcpUrl.trim() && config.apiMcpToken.trim());
}
