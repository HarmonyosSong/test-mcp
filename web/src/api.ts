import type {
  CaseDraft,
  ChatConversation,
  ChatConversationSummary,
  CreateCaseInput,
  CreateConversationInput,
  DiagnosticCase,
  HealthResponse,
  MetaResponse,
  ModelConfigInput,
  ModelConnectionResult,
  ModelProviderPreset,
  ModelStatus,
  RegisterRepositoryInput,
  RepositoryBranch,
  RepositoryRecord,
  RepositorySnapshot,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE || '/harmonyos_agent').replace(/\/$/, '');
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
    const response = await fetch(`${API_BASE}${path}`, {
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
  health: () => request<HealthResponse>('/api/health'),
  meta: () => request<MetaResponse>('/api/meta'),
  listCases: () => request<DiagnosticCase[]>('/api/cases'),
  getCase: (id: string) => request<DiagnosticCase>(`/api/cases/${id}`),
  createCase: (input: CreateCaseInput) =>
    request<DiagnosticCase>(
      '/api/cases',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      180_000,
    ),
  repositories: () => request<RepositoryRecord[]>('/api/repositories'),
  registerRepository: (input: RegisterRepositoryInput) =>
    request<RepositoryRecord>(
      '/api/repositories',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      60_000,
    ),
  repositoryBranches: (repositoryId: string, query = '') =>
    request<RepositoryBranch[]>(
      `/api/repositories/${repositoryId}/branches?query=${encodeURIComponent(query)}`,
      undefined,
      60_000,
    ),
  createRepositorySnapshot: (repositoryId: string, branch: string) =>
    request<RepositorySnapshot>(
      `/api/repositories/${repositoryId}/snapshots`,
      {
        method: 'POST',
        body: JSON.stringify({ branch }),
      },
      180_000,
    ),
  modelProviders: () => request<ModelProviderPreset[]>('/api/model/providers'),
  availableModels: () => request<string[]>('/api/model/available-models'),
  probeModels: (input: {
    provider: string;
    base_url?: string;
    api_key?: string;
    no_api_key: boolean;
  }) =>
    request<string[]>(
      '/api/model/available-models',
      { method: 'POST', body: JSON.stringify(input) },
      20_000,
    ),
  modelStatus: () => request<ModelStatus>('/api/model/status'),
  configureModel: (input: ModelConfigInput) =>
    request<ModelStatus>('/api/model/config', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  testModel: (input: ModelConfigInput) =>
    request<ModelConnectionResult>(
      '/api/model/test',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      25_000,
    ),
  disableModel: () =>
    request<ModelStatus>('/api/model/config', {
      method: 'DELETE',
    }),
  listConversations: () => request<ChatConversationSummary[]>('/api/conversations'),
  createConversation: (input: CreateConversationInput) =>
    request<ChatConversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getConversation: (id: string) => request<ChatConversation>(`/api/conversations/${id}`),
  updateConversation: (id: string, patch: { title?: string; model_override?: string }) =>
    request<ChatConversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),
  promoteDraft: (conversationId: string) =>
    request<CaseDraft>(
      `/api/conversations/${conversationId}/promote-draft`,
      { method: 'POST', body: JSON.stringify({}) },
      180_000,
    ),
  linkCase: (conversationId: string, caseId: string) =>
    request<ChatConversation>(`/api/conversations/${conversationId}/cases`, {
      method: 'POST',
      body: JSON.stringify({ case_id: caseId }),
    }),
};
