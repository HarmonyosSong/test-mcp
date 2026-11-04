import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  ModelConfigRequestSchema,
  ModelProviderPresetSchema,
  ModelStatusSchema,
  type ModelConfigRequest,
} from '../domain/schemas.js';
import { redactSensitiveText } from '../security/redaction.js';

export const MODEL_PROVIDER_PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-5.2',
    suggested_models: ['gpt-5.2', 'gpt-5-mini'],
    api_key_env: 'OPENAI_API_KEY',
    note: '当前没有真实 provider 调用与诊断质量验收记录；连接测试通过不代表诊断质量已验收。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    default_model: 'deepseek-flash',
    suggested_models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    api_key_env: 'DEEPSEEK_API_KEY',
    note: 'deepseek-flash 已通过本仓库七轮代表性评测及逐轮复核；这是回归样本，不代表总体质量保证。',
  },
  {
    id: 'qwen',
    name: '通义千问（DashScope）',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_model: 'qwen-plus',
    suggested_models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    api_key_env: 'DASHSCOPE_API_KEY',
    note: '当前没有真实 provider 调用与诊断质量验收记录。企业 Workspace 可将 Base URL 替换为对应地域的 maas.aliyuncs.com 地址。',
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    base_url: 'https://api.kimi.com/coding/v1',
    default_model: 'kimi-for-coding',
    suggested_models: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed'],
    api_key_env: 'MOONSHOT_API_KEY',
    note: 'Kimi Code 端点连接已验证，但 Kimi 全系列当前仅作实验型号；诊断质量尚未达到本项目正式支持门槛。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    default_model: 'glm-5.3',
    suggested_models: ['glm-5.3', 'glm-4-flash', 'glm-4-plus'],
    api_key_env: 'ZHIPUAI_API_KEY',
    note: '当前没有真实 provider 调用与诊断质量验收记录；连接测试通过不代表诊断质量已验收。',
  },
  {
    id: 'doubao',
    name: '火山方舟 / 豆包',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    default_model: 'doubao-seed-2-1-pro-260628',
    suggested_models: ['doubao-seed-2-1-pro-260628'],
    api_key_env: 'ARK_API_KEY',
    note: '当前没有真实 provider 调用与诊断质量验收记录。模型字段兼容当前 Model ID、历史 ep-* 接入点和私有部署标识。',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容接口',
    base_url: '',
    default_model: '',
    suggested_models: [],
    requires_api_key: false,
    api_key_env: null,
    note: '自定义接口仅有本地协议 fixture 验证；请先测试连接并独立验证模型输出。',
  },
].map((preset) => ModelProviderPresetSchema.parse(preset));

const presetsById = new Map(MODEL_PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export type ModelConfigSource = 'environment' | 'persisted' | 'runtime';

interface ResolvedModelConfiguration {
  provider: string;
  providerName: string;
  modelName: string;
  baseUrl: string | null;
  apiKey: string | null;
  source: ModelConfigSource;
  compatibilityMode: 'standard' | 'relaxed';
}

export interface ModelDiscoveryConfiguration {
  provider: string;
  base_url: string;
  api_key: string | null;
}

export interface AgentModelConfiguration extends ModelDiscoveryConfiguration {
  model_id: string;
  compatibility_mode: 'standard' | 'relaxed';
}

export interface ModelConfigurationOptions {
  filePath: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

export class ModelConfigurationError extends Error {}

function normalizeSecret(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function persistedPayload(config: ResolvedModelConfiguration): string {
  return JSON.stringify({
    provider: config.provider,
    model_name: config.modelName,
    base_url: config.baseUrl,
    api_key: config.apiKey,
    compatibility_mode: config.compatibilityMode,
  });
}

function inlineLocalSchemaRefs(value: unknown, definitions: Record<string, unknown>, active = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineLocalSchemaRefs(item, definitions, active));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const reference = record.$ref;
  if (typeof reference === 'string' && reference.startsWith('#/$defs/')) {
    const name = reference.slice('#/$defs/'.length);
    const target = definitions[name];
    if (target === undefined || active.has(name)) return value;
    const next = new Set(active).add(name);
    const expanded = inlineLocalSchemaRefs(target, definitions, next);
    const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== '$ref'));
    return { ...(expanded as Record<string, unknown>), ...inlineLocalSchemaRefs(siblings, definitions, next) as Record<string, unknown> };
  }
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== '$defs')
    .map(([key, item]) => [key, inlineLocalSchemaRefs(item, definitions, active)]));
}

export function transformRelaxedRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const transformed = { ...body };
  if (transformed.max_completion_tokens !== undefined) {
    transformed.max_tokens ??= transformed.max_completion_tokens;
    delete transformed.max_completion_tokens;
  }
  if (Array.isArray(transformed.messages)) {
    const messages = transformed.messages as Array<Record<string, unknown>>;
    const systems = messages.filter((message) => message.role === 'system');
    if (systems.length > 1) {
      const content = systems.map((message) => message.content).filter(Boolean).join('\n\n');
      let merged = false;
      transformed.messages = messages.flatMap((message) => {
        if (message.role !== 'system') return [message];
        if (merged) return [];
        merged = true;
        return [{ ...message, content }];
      });
    }
  }
  if (Array.isArray(transformed.tools)) {
    transformed.tools = (transformed.tools as Array<Record<string, unknown>>).map((tool) => {
      const fn = tool.function;
      if (typeof fn !== 'object' || fn === null) return tool;
      const definition = fn as Record<string, unknown>;
      const parameters = definition.parameters;
      if (typeof parameters !== 'object' || parameters === null) return { ...tool, function: Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'strict')) };
      const schema = parameters as Record<string, unknown>;
      const definitions = (schema.$defs && typeof schema.$defs === 'object' ? schema.$defs : {}) as Record<string, unknown>;
      return {
        ...tool,
        function: {
          ...Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'strict')),
          parameters: inlineLocalSchemaRefs(schema, definitions),
        },
      };
    });
  }
  return transformed;
}

export function redactSecret(message: string, secret: string | null | undefined): string {
  return secret ? message.split(secret).join('***') : message;
}

export class ModelConfiguration {
  private readonly filePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch?: typeof globalThis.fetch;
  private active: ResolvedModelConfiguration | null;

  constructor(options: ModelConfigurationOptions) {
    this.filePath = options.filePath;
    this.env = options.env ?? process.env;
    this.fetch = options.fetch;
    this.active = this.fromEnvironment() ?? null;
  }

  async initialize(): Promise<void> {
    if (this.active) return;
    this.active = await this.readPersisted();
  }

  get enabled(): boolean {
    return this.active !== null;
  }

  providers() {
    return MODEL_PROVIDER_PRESETS.map((preset) => ModelProviderPresetSchema.parse(preset));
  }

  status() {
    const config = this.active;
    return ModelStatusSchema.parse(config
      ? {
          mode: 'model',
          configured: true,
          provider: config.provider,
          provider_name: config.providerName,
          model_name: config.modelName,
          base_url: config.baseUrl,
          api_key_configured: Boolean(config.apiKey),
          source: config.source,
          compatibility_mode: config.compatibilityMode,
        }
      : { mode: 'demo', configured: false });
  }

  async configure(input: ModelConfigRequest | unknown) {
    await this.initialize();
    const request = ModelConfigRequestSchema.parse(input);
    const preset = presetsById.get(request.provider);
    if (!preset) throw new ModelConfigurationError('unsupported model provider');

    const baseUrl = request.base_url || preset.base_url || null;
    if (!baseUrl) throw new ModelConfigurationError('base_url is required for the custom provider');
    const apiKey = request.no_api_key ? null : this.resolveRequestKey(request, preset, baseUrl);
    if (preset.requires_api_key && !apiKey) {
      throw new ModelConfigurationError('api_key is required for this provider');
    }

    const resolved: ResolvedModelConfiguration = {
      provider: preset.id,
      providerName: preset.name,
      modelName: request.model_name,
      baseUrl,
      apiKey,
      source: 'runtime',
      compatibilityMode: request.compatibility_mode,
    };
    await this.persist(resolved);
    this.active = resolved;
    return this.status();
  }

  async disable() {
    this.active = null;
    await rm(this.filePath, { force: true });
    return this.status();
  }

  /** Resolve provider/base URL/credential inputs for a caller that performs GET /models. */
  async resolveDiscovery(input: unknown): Promise<ModelDiscoveryConfiguration> {
    await this.initialize();
    const request = ModelConfigRequestSchema.parse({
      ...(input as Record<string, unknown>),
      model_name: 'discovery-placeholder',
    });
    const preset = presetsById.get(request.provider);
    if (!preset) throw new ModelConfigurationError('unsupported model provider');
    const baseUrl = request.base_url || preset.base_url || null;
    if (!baseUrl) throw new ModelConfigurationError('base_url is required for the custom provider');

    let apiKey: string | null = null;
    if (!request.no_api_key) {
      apiKey = normalizeSecret(request.api_key);
      if (!apiKey && this.active?.provider === request.provider && this.active.baseUrl === baseUrl) {
        apiKey = this.active.apiKey;
      }
      if (!apiKey && preset.api_key_env) apiKey = normalizeSecret(this.env[preset.api_key_env]);
    }
    return { provider: preset.id, base_url: baseUrl, api_key: apiKey };
  }

  async configuredDiscovery(): Promise<ModelDiscoveryConfiguration> {
    await this.initialize();
    if (!this.active) throw new ModelConfigurationError('model is not configured');
    if (!this.active.baseUrl) throw new ModelConfigurationError('base_url is required for the custom provider');
    return {
      provider: this.active.provider,
      base_url: this.active.baseUrl,
      api_key: this.active.apiKey,
    };
  }

  async agentModel(spec?: string | null): Promise<AgentModelConfiguration> {
    await this.initialize();
    if (!this.active) throw new ModelConfigurationError('model is not configured');
    let provider = this.active.provider;
    let modelName = this.active.modelName;
    if (spec) {
      const separator = spec.indexOf(':');
      if (separator >= 0) {
        const overrideProvider = spec.slice(0, separator);
        const overrideModel = spec.slice(separator + 1);
        if (overrideProvider === provider && overrideModel) modelName = overrideModel;
      } else {
        modelName = spec;
      }
    }
    const preset = presetsById.get(provider);
    return {
      provider,
      base_url: this.active.baseUrl ?? preset?.base_url ?? '',
      api_key: this.active.apiKey,
      model_id: modelName,
      compatibility_mode: this.active.compatibilityMode,
    };
  }

  async languageModel(spec?: string | null) {
    const resolved = await this.agentModel(spec);
    const provider = createOpenAICompatible({
      name: resolved.provider,
      baseURL: resolved.base_url,
      apiKey: resolved.api_key ?? '',
      supportsStructuredOutputs: resolved.compatibility_mode === 'standard',
      ...(this.fetch ? { fetch: this.fetch } : {}),
      ...(resolved.compatibility_mode === 'relaxed' ? { transformRequestBody: transformRelaxedRequestBody } : {}),
    });
    return provider.chatModel(resolved.model_id);
  }

  redact(message: string): string {
    return redactSensitiveText(redactSecret(message, this.active?.apiKey), this.env);
  }

  private resolveRequestKey(
    request: ModelConfigRequest,
    preset: (typeof MODEL_PROVIDER_PRESETS)[number],
    baseUrl: string,
  ): string | null {
    const supplied = normalizeSecret(request.api_key);
    if (supplied) return supplied;
    if (
      this.active &&
      ['runtime', 'persisted'].includes(this.active.source) &&
      this.active.provider === request.provider &&
      this.active.baseUrl === baseUrl
    ) {
      return this.active.apiKey;
    }
    return preset.api_key_env ? normalizeSecret(this.env[preset.api_key_env]) : null;
  }

  private fromEnvironment(): ResolvedModelConfiguration | undefined {
    if ((this.env.HARMONY_AGENT_MODE ?? 'demo') !== 'model') return undefined;
    const configuredModel = this.env.HARMONY_AGENT_MODEL ?? 'deepseek:deepseek-flash';
    const separator = configuredModel.indexOf(':');
    const provider = separator >= 0 ? configuredModel.slice(0, separator) : 'configured';
    const modelName = separator >= 0 ? configuredModel.slice(separator + 1) : configuredModel;
    const preset = presetsById.get(provider);
    return {
      provider,
      providerName: preset?.name ?? provider,
      modelName,
      baseUrl: preset?.base_url || null,
      apiKey: preset?.api_key_env ? normalizeSecret(this.env[preset.api_key_env]) : null,
      source: 'environment',
      compatibilityMode: 'standard',
    };
  }

  private async readPersisted(): Promise<ResolvedModelConfiguration | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const preset = presetsById.get(typeof record.provider === 'string' ? record.provider : '');
    if (!preset) return null;
    const request = ModelConfigRequestSchema.safeParse({
      provider: record.provider,
      model_name: record.model_name,
      base_url: record.base_url,
      api_key: record.api_key,
      compatibility_mode: record.compatibility_mode ?? 'standard',
    });
    if (!request.success) return null;
    const baseUrl = request.data.base_url || preset.base_url || null;
    if (!baseUrl) return null;
    return {
      provider: preset.id,
      providerName: preset.name,
      modelName: request.data.model_name,
      baseUrl,
      apiKey: normalizeSecret(request.data.api_key),
      source: 'persisted',
      compatibilityMode: request.data.compatibility_mode,
    };
  }

  private async persist(config: ResolvedModelConfiguration): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, persistedPayload(config), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
