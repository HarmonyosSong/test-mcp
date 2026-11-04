import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { RuntimeConfig } from '../config.js';

const ProductRouteSchema = z.object({
  business_line: z.string().min(1),
  product_id: z.string().min(1),
  terms: z.array(z.string().min(1)).min(1),
  topic_terms: z.record(z.string(), z.array(z.string().min(1))).default({}),
}).strict();

const ExternalKnowledgeConfigSchema = z.object({
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  url: z.string().optional(),
  token_env: z.string().min(1).optional(),
  timeout_seconds: z.number().min(0.1).max(120).default(30),
  max_result_chars: z.number().int().min(2000).max(32000).default(16000),
  products: z.array(ProductRouteSchema).min(1),
  excluded_terms: z.array(z.string().min(1)).default([]),
}).strict().superRefine((value, context) => {
  if (value.transport === 'stdio') {
    if (!value.command || value.url || value.token_env) context.addIssue({ code: 'custom', message: 'invalid stdio transport configuration' });
  } else {
    let endpoint: URL;
    try { endpoint = new URL(value.url ?? ''); } catch { context.addIssue({ code: 'custom', message: 'HTTP requires an absolute endpoint' }); return; }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      context.addIssue({ code: 'custom', message: 'invalid HTTP endpoint' });
    }
    if (value.command || value.args.length || value.cwd) context.addIssue({ code: 'custom', message: 'HTTP transport cannot execute a command' });
    if (value.token_env && endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
      context.addIssue({ code: 'custom', message: 'remote bearer credentials require HTTPS' });
    }
  }
  const routes = value.products.map((route) => `${route.business_line}\0${route.product_id}`);
  if (new Set(routes).size !== routes.length) context.addIssue({ code: 'custom', message: 'duplicate product route' });
});

export type ExternalConfig = z.infer<typeof ExternalKnowledgeConfigSchema>;
type McpTool = { execute?: (args: Record<string, unknown>, context: unknown) => Promise<unknown> };
type ExternalMcpToolset = Record<string, McpTool>;
type ExternalToolCall = (name: 'wiki_resolve' | 'wiki_read', args: Record<string, unknown>, context: unknown) => Promise<unknown>;

export function decodeExternalMcpResult(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('external_contract_error: expected one JSON response');
  const response = value as { isError?: unknown; structuredContent?: unknown; content?: unknown };
  if (response.isError === true) throw new Error('external_tool_error: upstream rejected the request');
  if (response.structuredContent !== undefined) {
    if (typeof response.structuredContent !== 'object' || response.structuredContent === null || Array.isArray(response.structuredContent)) throw new Error('external_contract_error: expected a JSON object response');
    return response.structuredContent as Record<string, unknown>;
  }
  if (Array.isArray(response.content)) {
    const blocks = response.content.filter((item): item is { type: string; text: string } => typeof item === 'object' && item !== null && 'type' in item && 'text' in item && typeof item.text === 'string' && item.type === 'text');
    if (blocks.length !== 1) throw new Error('external_contract_error: expected one JSON response');
    const parsed = JSON.parse(blocks[0].text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('external_contract_error: expected a JSON object response');
    return parsed as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

function contains(text: string, terms: string[]): boolean {
  const normalized = text.toLocaleLowerCase();
  return terms.some((term) => normalized.includes(term.toLocaleLowerCase()));
}

function topicIdentity(value: Record<string, unknown>): string {
  return `${value.business_line}\0${value.product_id}\0${value.topic_id}`;
}

function encodedSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function boundedResult(input: Record<string, any>, limit: number): Record<string, any> {
  const value = structuredClone(input);
  if (encodedSize(value) <= limit) return value;
  value.truncated = true;
  value.truncation = {
    reason: 'consumer_result_budget',
    next_action: 'Read fewer sections; do not repeat an oversized single section.',
    upstream: value.truncation ?? null,
  };
  if (Array.isArray(value.candidates)) {
    for (const candidate of value.candidates) {
      delete candidate.snippets;
      delete candidate.summary;
    }
  } else if (value.status === 'ok' && Array.isArray(value.sections)) {
    const omitted: string[] = [];
    while (value.sections.length && encodedSize(value) > limit) {
      omitted.push(value.sections.pop().section_id);
      const refs = new Set(value.sections.flatMap((section: any) => section.items.flatMap((item: any) => item.source_ref_keys)));
      value.source_catalog = Object.fromEntries(Object.entries(value.source_catalog).filter(([key]) => refs.has(key)));
      const sourceIds = new Set(Object.values(value.source_catalog).flatMap((item: any) => item.kind === 'code' ? [item.code_source_id] : []));
      value.code_sources = Object.fromEntries(Object.entries(value.code_sources).filter(([key]) => sourceIds.has(key)));
    }
    value.truncation.omitted_section_ids = omitted;
    if (!value.sections.length) return { status: 'response_too_large', key: value.key, truncated: true, truncation: value.truncation };
  }
  if (encodedSize(value) > limit) return { status: 'response_too_large', truncated: true, gap_reason: 'Metadata exceeds the consumer budget; use another evidence source.' };
  return value;
}

export class ExternalKnowledgeAdapter {
  private readonly resolved = new Map<string, Set<string>>();

  constructor(
    private readonly config: ExternalConfig,
    private readonly inputTexts: string[],
    private readonly call: ExternalToolCall,
    private readonly projectRoot: string,
  ) {}

  async resolve(queryInput: string, productId: string | undefined, context: unknown): Promise<Record<string, unknown>> {
    const query = queryInput.trim();
    if (!query || query.length > 400 || !this.inputTexts.some((text) => text.includes(query))) {
      throw new Error('Use a short verbatim symptom from user input, not an invented query.');
    }
    if (/bearer\s|password\s*[:=]|token\s*[:=]|secret\s*[:=]|\b1[3-9]\d{9}\b/i.test(query)) {
      throw new Error('Select a symptom without credentials or personal identifiers.');
    }
    if (contains(query, this.config.excluded_terms)) return { status: 'not_covered', gap_reason: 'Use local knowledge and evidence.' };
    let routes = this.config.products.filter((route) => contains(query, [route.product_id, ...route.terms]));
    if (!routes.length) {
      for (const text of [...this.inputTexts].reverse()) {
        if (contains(text, this.config.excluded_terms)) break;
        routes = this.config.products.filter((route) => contains(text, [route.product_id, ...route.terms]));
        if (routes.length) break;
      }
    }
    if (routes.length !== 1 || (productId && routes[0].product_id !== productId)) {
      return { status: 'needs_clarification', gap_reason: 'Confirm product and entry route.' };
    }
    const route = routes[0];
    let rewritten = query;
    for (const alias of route.terms.slice(1)) rewritten = rewritten.replaceAll(alias, route.terms[0]);
    if (!rewritten.toLocaleLowerCase().includes(route.terms[0].toLocaleLowerCase())) rewritten = `${route.terms[0]} ${rewritten}`;
    const args = { query: rewritten, business_line: route.business_line, product_id: route.product_id, limit: 3 };
    const response = await this.call('wiki_resolve', args, context) as Record<string, any>;
    await validateContract('wiki_resolve', args, response, this.projectRoot);
    if (response.status === 'invalid_request') throw new Error('external_invalid_request: request rejected');
    const expectedTopics = Object.entries(route.topic_terms).filter(([topic, terms]) => contains(query, [topic, ...terms])).map(([topic]) => topic);
    if (['resolved', 'ambiguous'].includes(response.status) && expectedTopics.length && !response.candidates.some((candidate: any) => expectedTopics.includes(candidate.topic_id))) {
      throw new Error('external_topic_mismatch: candidate conflicts with the known activity');
    }
    const result = boundedResult(response, this.config.max_result_chars);
    if (response.status === 'resolved') {
      const candidate = response.candidates[0];
      this.resolved.set(topicIdentity(candidate), new Set(candidate.recommended_sections.map((section: any) => section.section_id)));
    }
    return { source: 'dev-knowledge', original_query: query, usage: 'Topic leads only. Verify semantic fit before reading; not incident evidence.', result };
  }

  async read(businessLine: string, productId: string, topicId: string, sectionIds: string[], context: unknown): Promise<Record<string, unknown>> {
    const key = `${businessLine}\0${productId}\0${topicId}`;
    const allowed = this.resolved.get(key) ?? new Set<string>();
    if (sectionIds.length < 1 || sectionIds.length > 3 || new Set(sectionIds).size !== sectionIds.length || !sectionIds.every((id) => allowed.has(id))) {
      throw new Error('Read 1-3 recommended sections of this turn\'s resolved topic.');
    }
    const args = { business_line: businessLine, product_id: productId, topic_id: topicId, section_ids: sectionIds };
    const response = await this.call('wiki_read', args, context) as Record<string, any>;
    await validateContract('wiki_read', args, response, this.projectRoot);
    if (response.status === 'invalid_request') throw new Error('external_invalid_request: request rejected');
    return { source: 'dev-knowledge', usage: 'Static knowledge, not observed incident evidence.', result: boundedResult(response, this.config.max_result_chars) };
  }
}

let validators: { wiki_resolve: (value: unknown) => boolean; wiki_read: (value: unknown) => boolean } | undefined;
async function getValidators(projectRoot: string) {
  if (validators) return validators;
  const contract = JSON.parse(await readFile(`${projectRoot}/runtime/contracts/dev-knowledge/mcp-responses.schema.json`, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  validators = {
    wiki_resolve: ajv.compile({ $defs: contract.$defs, ...contract.properties.wiki_resolve }),
    wiki_read: ajv.compile({ $defs: contract.$defs, ...contract.properties.wiki_read }),
  };
  return validators;
}

async function validateContract(tool: 'wiki_resolve' | 'wiki_read', args: Record<string, any>, response: Record<string, any>, projectRoot = process.cwd()): Promise<void> {
  const checks = await getValidators(projectRoot);
  if (!checks[tool](response)) throw new Error('external_contract_error: response schema failed');
  if (Boolean(response.truncated) !== Boolean(response.truncation)) throw new Error('external_contract_error: truncation contract failed');
  if (tool === 'wiki_resolve' && ['resolved', 'ambiguous', 'not_found'].includes(response.status)) {
    if (response.query !== args.query || response.candidates.length > args.limit) throw new Error('external_contract_error: query echo failed');
    const identities = response.candidates.map(topicIdentity);
    if (new Set(identities).size !== identities.length || response.candidates.some((candidate: any) => candidate.business_line !== args.business_line || candidate.product_id !== args.product_id)) throw new Error('external_contract_error: candidate identity failed');
    if (response.status === 'resolved' && (response.candidates.length !== 1 || response.candidates[0].confidence !== 'high' || response.resolution?.credible_candidate_count !== 1 || response.resolution?.confidence !== 'high')) throw new Error('external_contract_error: resolution contract failed');
    if (response.status === 'not_found' && response.candidates.length || response.status === 'ambiguous' && !response.candidates.length) throw new Error('external_contract_error: candidate status failed');
    return;
  }
  if (tool !== 'wiki_read') return;
  if (response.key && topicIdentity(response.key) !== topicIdentity(args)) throw new Error('external_contract_error: read key mismatch');
  if (response.status !== 'ok') return;
  if (topicIdentity(response.topic) !== topicIdentity(args)) throw new Error('external_contract_error: topic mismatch');
  const sections = response.sections.map((section: any) => section.section_id);
  if (new Set(sections).size !== sections.length || sections.some((id: string) => !args.section_ids.includes(id)) || (!response.truncated && sections.length !== args.section_ids.length)) throw new Error('external_contract_error: section mismatch');
  const refs = new Set<string>(response.sections.flatMap((section: any) => section.items.flatMap((item: any) => item.source_ref_keys)));
  if (refs.size !== Object.keys(response.source_catalog).length || [...refs].some((ref) => !(ref in response.source_catalog))) throw new Error('external_contract_error: source references mismatch');
  const usedCodeSources = new Set<string>();
  for (const locator of Object.values(response.source_catalog) as any[]) {
    const path = locator.relative_path as string;
    if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\') || path.includes(':')) throw new Error('external_contract_error: unsafe source path');
    if (locator.kind !== 'code') {
      if (locator.line_ranges.some(([start, end]: number[]) => start < 1 || start > end)) throw new Error('external_contract_error: invalid document lines');
      continue;
    }
    const source = response.code_sources[locator.code_source_id];
    if (!source || locator.source_id !== source.source_role || locator.start_line > locator.end_line) throw new Error('external_contract_error: invalid code source');
    usedCodeSources.add(locator.code_source_id);
    const matchingServices = source.logical_services.filter((service: any) => !service.path_prefix || path === service.path_prefix || path.startsWith(`${service.path_prefix.replace(/\/$/, '')}/`)).map((service: any) => service.service_id);
    if (JSON.stringify([...matchingServices].sort()) !== JSON.stringify([...locator.service_ids].sort())) throw new Error('external_contract_error: service scope mismatch');
    const repository = source.repository;
    if ((repository.identity_status === 'confirmed' && (!repository.host || !repository.full_name)) || (repository.identity_status !== 'confirmed' && (repository.host !== null || repository.full_name !== null))) throw new Error('external_contract_error: repository identity mismatch');
  }
  if (usedCodeSources.size !== Object.keys(response.code_sources).length || [...usedCodeSources].some((id) => !(id in response.code_sources))) throw new Error('external_contract_error: unused code source');
}

export async function createExternalKnowledgeTools(
  configPath: string | undefined,
  inputTexts: string[],
  projectRoot: string,
  call: ExternalToolCall,
) {
  if (!configPath) return null;
  let config: ExternalConfig;
  try {
    config = ExternalKnowledgeConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  } catch {
    return { tools: createFallbackTools('external_configuration_error: check the configured JSON file') };
  }
  await getValidators(projectRoot);
  return { tools: createExternalKnowledgeToolsForConfig(config, inputTexts, projectRoot, call) };
}

export function loadExternalKnowledgeConfig(configPath: string): Promise<ExternalConfig> {
  return readFile(configPath, 'utf8').then((text) => ExternalKnowledgeConfigSchema.parse(JSON.parse(text)));
}

export function parseExternalKnowledgeConfig(value: unknown): ExternalConfig {
  return ExternalKnowledgeConfigSchema.parse(value);
}

export function createExternalKnowledgeToolsForConfig(
  config: ExternalConfig,
  inputTexts: string[],
  projectRoot: string,
  call: ExternalToolCall,
) {
  const adapter = new ExternalKnowledgeAdapter(config, inputTexts, async (name, args, context) => {
    try {
      const result = await call(name, args, context);
      if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('invalid response');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('external_contract_error') || message.includes('external_invalid_request')) throw error;
      if (message.includes('external_auth_missing')) throw new Error(message);
      if (/timed?\s*out/i.test(message)) throw new Error('external_timeout: report the gap; no automatic retry');
      throw new Error('external_transport_error: check service and authentication');
    }
  }, projectRoot);
  return {
    resolve_external_knowledge: createTool({
      id: 'resolve_external_knowledge',
      description: 'Locate external knowledge using a short verbatim symptom and locally configured product coverage. Unknown scope asks for clarification; returned topics are leads, not incident evidence.',
      inputSchema: z.strictObject({ query: z.string().min(1).max(400) }),
      execute: ({ query }, context) => adapter.resolve(query, undefined, context),
    }),
    read_external_knowledge: createTool({
      id: 'read_external_knowledge',
      description: 'Read one to three recommended sections from a topic resolved during this turn. Static content and locators are not incident evidence.',
      inputSchema: z.object({ business_line: z.string(), product_id: z.string(), topic_id: z.string(), section_ids: z.array(z.string()).min(1).max(3) }),
      execute: ({ business_line, product_id, topic_id, section_ids }, context) => adapter.read(business_line, product_id, topic_id, section_ids, context),
    }),
  };
}

function createFallbackTools(message: string) {
  return {
    resolve_external_knowledge: createTool({ id: 'resolve_external_knowledge', description: 'Resolve covered external development knowledge.', inputSchema: z.strictObject({ query: z.string() }), execute: async () => { throw new Error(message); } }),
    read_external_knowledge: createTool({ id: 'read_external_knowledge', description: 'Read recommended external development knowledge.', inputSchema: z.object({ business_line: z.string(), product_id: z.string(), topic_id: z.string(), section_ids: z.array(z.string()) }), execute: async () => { throw new Error(message); } }),
  };
}

export type { ExternalToolCall, ExternalMcpToolset };
