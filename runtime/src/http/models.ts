import { Hono } from 'hono';

import { AvailableModelsRequestSchema, ModelConfigRequestSchema } from '../domain/schemas.js';
import {
  ModelConfiguration,
  ModelConfigurationError,
} from '../model/configuration.js';

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

export function createModelRoutes(configuration: ModelConfiguration): Hono {
  const routes = new Hono();

  routes.get('/model/providers', (context) => context.json(configuration.providers()));
  routes.get('/model/status', async (context) => context.json(await configuration.status()));

  routes.put('/model/config', async (context) => {
    try {
      const status = await configuration.configure(await context.req.json());
      return context.json(status);
    } catch (error) {
      if (error instanceof ModelConfigurationError || error instanceof SyntaxError) {
        return errorResponse(error.message, 422);
      }
      return errorResponse('invalid model configuration', 422);
    }
  });

  routes.delete('/model/config', async (context) => context.json(await configuration.disable()));

  routes.get('/model/available-models', async (context) => {
    try {
      const target = await configuration.configuredDiscovery();
      return context.json(await discoverModels(target.base_url, target.api_key));
    } catch (error) {
      if (error instanceof ModelConfigurationError) return errorResponse(error.message, 409);
      return errorResponse('模型列表获取失败', 502);
    }
  });

  routes.post('/model/available-models', async (context) => {
    try {
      const payload = AvailableModelsRequestSchema.parse(await context.req.json());
      const target = await configuration.resolveDiscovery(payload);
      return context.json(await discoverModels(target.base_url, target.api_key));
    } catch (error) {
      if (error instanceof ModelConfigurationError || error instanceof SyntaxError) {
        return errorResponse(error instanceof Error ? error.message : 'invalid request', 422);
      }
      return errorResponse('模型列表获取失败', 502);
    }
  });

  routes.post('/model/test', async (context) => {
    const started = performance.now();
    try {
      const payload = ModelConfigRequestSchema.parse(await context.req.json());
      const target = await configuration.resolveDiscovery(payload);
      if (!target.api_key && payload.no_api_key !== true) {
        throw new ModelConfigurationError('api_key is required for this provider');
      }
      const response = await fetchWithTimeout(`${target.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(target.api_key ? { authorization: `Bearer ${target.api_key}` } : {}),
        },
        body: JSON.stringify({
          model: payload.model_name,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 8,
        }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.message as Record<string, unknown> | undefined;
      return context.json({
        ok: true,
        provider: target.provider,
        model_name: payload.model_name,
        latency_ms: Math.max(1, Math.round(performance.now() - started)),
        response_preview: typeof message?.content === 'string' ? message.content.slice(0, 120) : 'OK',
      });
    } catch (error) {
      if (error instanceof ModelConfigurationError || error instanceof SyntaxError) {
        return errorResponse(error instanceof Error ? error.message : 'invalid request', 422);
      }
      return errorResponse(`模型连接失败：${error instanceof Error ? configuration.redact(error.message) : 'unknown error'}`, 502);
    }
  });

  return routes;
}

async function discoverModels(baseUrl: string, apiKey: string | null): Promise<string[]> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  const body = await response.json().catch(() => ({})) as { data?: Array<{ id?: unknown }> };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return [...new Set((body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string'))].sort();
}
