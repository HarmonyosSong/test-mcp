import { Hono } from 'hono';
import { AvailableModelsRequestSchema, ModelConfigRequestSchema } from '../domain/schemas.js';
import {
  ModelConfiguration,
  ModelConfigurationError,
} from '../model/configuration.js';
import { invalidJsonError, requestValidationError } from './errors.js';

function errorResponse(message: string, status: 409 | 422 | 502) {
  return new Response(JSON.stringify({ detail: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

class ModelConnectionError extends Error {}

async function fetchProvider(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init);
  } catch (error) {
    throw new ModelConnectionError(error instanceof Error ? error.message : 'connection failed', { cause: error });
  }
}

export function createModelRoutes(configuration: ModelConfiguration): Hono {
  const routes = new Hono();

  routes.get('/model/providers', (context) => context.json(configuration.providers()));
  routes.get('/model/status', async (context) => context.json(await configuration.status()));

  routes.put('/model/config', async (context) => {
    try {
      let requestBody: unknown;
      try { requestBody = await context.req.json(); } catch { return invalidJsonError(); }
      const parsed = ModelConfigRequestSchema.safeParse(requestBody);
      if (!parsed.success) return requestValidationError(parsed.error.issues);
      const status = await configuration.configure(parsed.data);
      return context.json(status);
    } catch (error) {
      if (error instanceof ModelConfigurationError) {
        return errorResponse(error.message, 422);
      }
      throw error;
    }
  });

  routes.delete('/model/config', async (context) => context.json(await configuration.disable()));

  routes.get('/model/available-models', async (context) => {
    try {
      const target = await configuration.configuredDiscovery();
      return context.json(await discoverModels(target.base_url, target.api_key));
    } catch (error) {
      if (error instanceof ModelConfigurationError) return errorResponse(error.message, 409);
      if (error instanceof ModelConnectionError) return errorResponse(`模型列表获取失败：${configuration.redact(error.message)}`, 502);
      throw error;
    }
  });

  routes.post('/model/available-models', async (context) => {
    let requestApiKey: string | null = null;
    try {
      let body: unknown;
      try { body = await context.req.json(); } catch { return invalidJsonError(); }
      const parsed = AvailableModelsRequestSchema.safeParse(body);
      if (!parsed.success) return requestValidationError(parsed.error.issues);
      const payload = parsed.data;
      requestApiKey = payload.api_key?.trim() || null;
      const target = await configuration.resolveDiscovery(payload);
      return context.json(await discoverModels(target.base_url, target.api_key));
    } catch (error) {
      if (error instanceof ModelConfigurationError) {
        return errorResponse(error instanceof Error ? error.message : 'invalid request', 422);
      }
      if (error instanceof ModelConnectionError) {
        const safeMessage = configuration.redact(error.message);
        return errorResponse(`模型列表获取失败：${redactRequestKey(safeMessage, requestApiKey)}`, 502);
      }
      throw error;
    }
  });

  routes.post('/model/test', async (context) => {
    const started = performance.now();
    let requestApiKey: string | null = null;
    const redactRequestKey = (value: string) => requestApiKey
      ? value.split(requestApiKey).join('[REDACTED]')
      : value;
    try {
      let requestBody: unknown;
      try { requestBody = await context.req.json(); } catch { return invalidJsonError(); }
      const parsed = ModelConfigRequestSchema.safeParse(requestBody);
      if (!parsed.success) return requestValidationError(parsed.error.issues);
      const payload = parsed.data;
      requestApiKey = payload.api_key?.trim() || null;
      const target = await configuration.resolveDiscovery(payload);
      if (!target.api_key && payload.no_api_key !== true) {
        throw new ModelConfigurationError('api_key is required for this provider');
      }
      const response = await fetchProvider(`${target.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(target.api_key ? { authorization: `Bearer ${target.api_key}` } : {}),
        },
        body: JSON.stringify({
          model: payload.model_name,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 128,
          ...(target.provider === 'moonshot' ? { reasoning_effort: 'low' } : {}),
        }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new ModelConnectionError(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.message as Record<string, unknown> | undefined;
      if (typeof message?.content !== 'string' || !message.content.trim()) {
        throw new ModelConnectionError('模型未返回有效文本');
      }
      return context.json({
        ok: true,
        provider: target.provider,
        model_name: payload.model_name,
        latency_ms: Math.max(1, Math.round(performance.now() - started)),
        response_preview: redactRequestKey(configuration.redact(message.content)).slice(0, 120),
      });
    } catch (error) {
      if (error instanceof ModelConfigurationError) {
        return errorResponse(error instanceof Error ? error.message : 'invalid request', 422);
      }
      if (error instanceof ModelConnectionError) {
        const safeMessage = redactRequestKey(configuration.redact(error.message));
        return errorResponse(`模型连接失败：${safeMessage}`, 502);
      }
      throw error;
    }
  });

  return routes;
}

async function discoverModels(baseUrl: string, apiKey: string | null): Promise<string[]> {
  const response = await fetchProvider(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    const detail = typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : `HTTP ${response.status}`;
    throw new ModelConnectionError(detail);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ModelConnectionError('模型列表响应格式无效');
  }
  const data = 'data' in body ? body.data : undefined;
  if (data !== undefined && !Array.isArray(data)) {
    throw new ModelConnectionError('模型列表响应格式无效');
  }
  const ids = (data ?? []).flatMap((item) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') return [];
    return [item.id];
  });
  return [...new Set(ids)].sort();
}

function redactRequestKey(value: string, key: string | null): string {
  return key ? value.split(key).join('[REDACTED]') : value;
}
