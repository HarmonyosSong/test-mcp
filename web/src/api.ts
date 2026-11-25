import { apiPath } from './auth/paths';
import { authenticatedFetch } from './auth/session-fetch';
import type {
  AiTraceSummary,
  AiTraceOrEventDetail,
  ChatConversation,
  ChatConversationSummary,
  CreateConversationInput,
  HealthResponse,
  MetaResponse,
  ModelConfigInput,
  ModelConnectionResult,
  ModelProviderPreset,
  ModelStatus,
} from './types';

const REQUEST_TIMEOUT_MS = 5_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await authenticatedFetch(apiPath(path), {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = `请求失败 (${response.status})`;
      try {
        const body = (await response.json()) as { detail?: string; message?: string };
        message = body.detail || body.message || message;
      } catch {
        // The status code still provides a useful error when no JSON body exists.
      }
      throw new ApiError(message, response.status);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('连接诊断服务超时');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  meta: () => request<MetaResponse>('/meta'),
  modelProviders: () => request<ModelProviderPreset[]>('/model/providers'),
  availableModels: () => request<string[]>('/model/available-models'),
  probeModels: (input: {
    provider: string;
    base_url?: string;
    api_key?: string;
    no_api_key: boolean;
  }) =>
    request<string[]>(
      '/model/available-models',
      { method: 'POST', body: JSON.stringify(input) },
      20_000,
    ),
  modelStatus: () => request<ModelStatus>('/model/status'),
  configureModel: (input: ModelConfigInput) =>
    request<ModelStatus>('/model/config', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  testModel: (input: ModelConfigInput) =>
    request<ModelConnectionResult>(
      '/model/test',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      25_000,
    ),
  disableModel: () =>
    request<ModelStatus>('/model/config', {
      method: 'DELETE',
    }),
  listConversations: () => request<ChatConversationSummary[]>('/conversations'),
  createConversation: (input: CreateConversationInput) =>
    request<ChatConversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getConversation: (id: string) => request<ChatConversation>(`/conversations/${id}`),
  updateConversation: (
    id: string,
    patch: { title?: string; model_override?: string },
  ) =>
    request<ChatConversation>(`/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteConversation: (id: string) =>
    request<void>(`/conversations/${id}`, { method: 'DELETE' }),
  listAiTraces: (id: string) => request<AiTraceSummary[]>(`/conversations/${id}/ai-traces`),
  getAiTrace: (id: string, traceId: string) =>
    request<AiTraceOrEventDetail>(`/conversations/${id}/ai-traces/${traceId}`),
};
