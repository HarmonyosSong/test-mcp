import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  decodeExternalMcpResult,
  ExternalKnowledgeAdapter,
  parseExternalKnowledgeConfig,
  type ExternalConfig,
} from '../src/capabilities/external-knowledge.js';
import { CapabilityMcp, knowledgeServerEnvironment } from '../src/capabilities/mcp.js';
import type { RuntimeConfig } from '../src/config.js';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contractDirectory = resolve(projectRoot, 'runtime/contracts/dev-knowledge');

async function fixture(name: string) {
  const value = JSON.parse(await readFile(resolve(contractDirectory, `examples/${name}.json`), 'utf8')) as Record<string, any>;
  return value.response;
}

function config(overrides: Partial<ExternalConfig> = {}): ExternalConfig {
  return parseExternalKnowledgeConfig({
    transport: 'http',
    url: 'http://127.0.0.1:9999/mcp/knowledge/v1',
    products: [{
      business_line: 'cloudlearn',
      product_id: 'demo',
      terms: ['Demo', '演示产品'],
      topic_terms: { 'topic-demo': ['指定活动'] },
    }],
    excluded_terms: ['口语岛'],
    ...overrides,
  });
}

test('external knowledge requires exact covered user scope and excludes sensitive or invented queries', async () => {
  let calls = 0;
  const operation = async () => {
    calls += 1;
    return fixture('wiki-resolve-ok');
  };

  const excluded = new ExternalKnowledgeAdapter(config(), ['口语岛没有分数'], operation, projectRoot);
  assert.equal((await excluded.resolve('口语岛没有分数', undefined, {})).status, 'not_covered');
  const unknown = new ExternalKnowledgeAdapter(config(), ['朗读完没有分数'], operation, projectRoot);
  assert.equal((await unknown.resolve('朗读完没有分数', undefined, {})).status, 'needs_clarification');
  const covered = new ExternalKnowledgeAdapter(config(), ['Demo 登录失败'], operation, projectRoot);
  await assert.rejects(covered.resolve('invented', undefined, {}), /verbatim symptom/);
  const sensitive = new ExternalKnowledgeAdapter(config(), ['Demo token=private'], operation, projectRoot);
  await assert.rejects(sensitive.resolve('Demo token=private', undefined, {}), /without credentials/);
  assert.equal(calls, 0);
});

test('external knowledge rewrites configured aliases, validates topic contracts, and limits reads to recommended sections', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const adapter = new ExternalKnowledgeAdapter(config(), ['我在演示产品', '登录失败'], async (name, args) => {
    calls.push({ name, args });
    if (name === 'wiki_resolve') {
      const response = await fixture('wiki-resolve-ok');
      response.query = args.query;
      return response;
    }
    const response = await fixture('wiki-read-ok');
    const requested = args.section_ids as string[];
    response.sections = response.sections.filter((section: { section_id: string }) => requested.includes(section.section_id));
    return response;
  }, projectRoot);

  const resolved = await adapter.resolve('登录失败', undefined, {});
  assert.equal(calls[0].args.query, 'Demo 登录失败');
  assert.equal((resolved.result as Record<string, unknown>).status, 'resolved');
  await assert.rejects(adapter.read('cloudlearn', 'demo', 'topic-demo', ['not-recommended'], {}), /recommended sections/);
  const read = await adapter.read('cloudlearn', 'demo', 'topic-demo', ['overview'], {});
  assert.equal((read.result as Record<string, unknown>).status, 'ok');
  assert.deepEqual(calls.map((item) => item.name), ['wiki_resolve', 'wiki_read']);
});

test('external knowledge rejects mismatched response identity and unsafe source locators', async () => {
  const wrongEcho = new ExternalKnowledgeAdapter(config(), ['Demo 登录'], async () => fixture('wiki-resolve-ok'), projectRoot);
  await assert.rejects(wrongEcho.resolve('Demo 登录', undefined, {}), /external_contract_error/);

  const adapter = new ExternalKnowledgeAdapter(config(), ['Demo 登录'], async (name, args) => {
    if (name === 'wiki_resolve') {
      const response = await fixture('wiki-resolve-ok');
      response.query = args.query;
      return response;
    }
    const response = await fixture('wiki-read-ok');
    response.topic.business_line = 'other';
    return response;
  }, projectRoot);
  await adapter.resolve('Demo 登录', undefined, {});
  await assert.rejects(adapter.read('cloudlearn', 'demo', 'topic-demo', ['overview'], {}), /external_contract_error/);
});

test('external transport validation prevents credentials in URLs and remote bearer tokens over HTTP', () => {
  assert.throws(() => config({ url: 'https://user:secret@example.com/mcp' }), /invalid HTTP endpoint/);
  assert.throws(() => config({ url: 'http://example.com/mcp', token_env: 'DEV_KNOWLEDGE_TOKEN' }), /require HTTPS/);
  assert.throws(() => parseExternalKnowledgeConfig({
    transport: 'stdio', command: 'uv', url: 'http://localhost/mcp', products: [{ business_line: 'x', product_id: 'y', terms: ['y'] }],
  }), /invalid stdio/);
});

test('knowledge MCP receives configured retrieval and preview strategies', () => {
  const environment = knowledgeServerEnvironment({
    projectRoot,
    knowledgeRoot: 'knowledge',
    knowledgeQueryLog: '.data/knowledge-queries.jsonl',
    knowledgeRetrievalMode: 'v2',
    knowledgePreviewStrategy: 'ranked',
  } as RuntimeConfig, 'conversation-1', 'message-1');
  assert.equal(environment.HARMONY_AGENT_KNOWLEDGE_RETRIEVAL_MODE, 'v2');
  assert.equal(environment.HARMONY_AGENT_KNOWLEDGE_PREVIEW_STRATEGY, 'ranked');
  assert.equal(environment.HARMONY_AGENT_QUERY_CONVERSATION_ID, 'conversation-1');
  assert.equal(environment.HARMONY_AGENT_QUERY_MESSAGE_ID, 'message-1');
});

test('external MCP response decoding accepts structured output and one JSON text block only', () => {
  assert.deepEqual(decodeExternalMcpResult({ status: 'resolved' }), { status: 'resolved' });
  assert.deepEqual(decodeExternalMcpResult({ structuredContent: { status: 'resolved' } }), { status: 'resolved' });
  assert.deepEqual(decodeExternalMcpResult({ isError: false, content: [{ type: 'text', text: '{"status":"resolved"}' }] }), { status: 'resolved' });
  assert.throws(() => decodeExternalMcpResult({ isError: true, content: [] }), /external_tool_error/);
  assert.throws(() => decodeExternalMcpResult({ content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }), /one JSON response/);
});

test('checked-in external knowledge contract bundle matches its integrity manifest', async () => {
  const manifest = JSON.parse(await readFile(resolve(contractDirectory, 'manifest.json'), 'utf8')) as { files: Record<string, string> };
  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    const bytes = await readFile(resolve(contractDirectory, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, `${name} hash mismatch`);
  }
});

test('Mastra MCP stdio session exposes only validated external tools and closes after the turn', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'mastra-external-mcp-'));
  const configPath = resolve(directory, 'external.json');
  const fixtureServer = resolve(dirname(fileURLToPath(import.meta.url)), 'external-mcp-fixture.ts');
  const tsxCommand = resolve(projectRoot, 'runtime/node_modules/.bin/tsx');
  await writeFile(configPath, JSON.stringify({
    transport: 'stdio',
    command: tsxCommand,
    args: [fixtureServer],
    cwd: projectRoot,
    products: [{ business_line: 'cloudlearn', product_id: 'demo', terms: ['Demo', '演示产品'] }],
  }));
  const capability = new CapabilityMcp({
    projectRoot,
    externalKnowledgeConfigFile: configPath,
  } as RuntimeConfig);

  try {
    const session = await capability.createExternalKnowledgeTools(['Demo 登录失败']);
    assert.ok(session?.client);
    assert.deepEqual(Object.keys(session!.tools).sort(), ['read_external_knowledge', 'resolve_external_knowledge']);
    const resolveSchema = (session!.tools.resolve_external_knowledge as unknown as {
      inputSchema: { safeParse(value: unknown): { success: boolean } };
    }).inputSchema;
    assert.equal(resolveSchema.safeParse({ query: 'Demo 登录失败' }).success, true);
    assert.equal(resolveSchema.safeParse({ query: 'Demo 登录失败', product_id: 'cloudlearn/demo' }).success, false);
    const resolveTool = session!.tools.resolve_external_knowledge as unknown as {
      execute(input: { query: string }, context: unknown): Promise<Record<string, unknown>>;
    };
    const result = await resolveTool.execute({ query: 'Demo 登录失败' }, {});
    assert.equal(result.source, 'dev-knowledge');
    const resolved = result.result as { status: string; candidates: Array<{ business_line: string; product_id: string; topic_id: string; recommended_sections: Array<{ section_id: string }> }> };
    assert.equal(resolved.status, 'resolved');
    const candidate = resolved.candidates[0];
    const readTool = session!.tools.read_external_knowledge as unknown as {
      execute(input: { business_line: string; product_id: string; topic_id: string; section_ids: string[] }, context: unknown): Promise<Record<string, unknown>>;
    };
    const read = await readTool.execute({
      business_line: candidate.business_line,
      product_id: candidate.product_id,
      topic_id: candidate.topic_id,
      section_ids: [candidate.recommended_sections[0].section_id],
    }, {});
    assert.equal((read.result as { status: string }).status, 'ok');
    await session!.client?.disconnect();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mastra MCP Streamable HTTP session executes the same validated tool contract', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'mastra-external-http-'));
  const mcpServer = new MCPServer({
    id: 'external-knowledge-http-fixture',
    name: 'External Knowledge HTTP Fixture',
    version: '1.0.0',
    tools: {
      wiki_resolve: createTool({
        id: 'wiki_resolve',
        description: 'Fixture external resolver',
        inputSchema: z.object({ query: z.string(), business_line: z.string(), product_id: z.string(), limit: z.number() }),
        execute: async ({ query }) => ({ ...(await fixture('wiki-resolve-ok')), query }),
      }),
      wiki_read: createTool({
        id: 'wiki_read',
        description: 'Fixture external reader',
        inputSchema: z.object({ business_line: z.string(), product_id: z.string(), topic_id: z.string(), section_ids: z.array(z.string()) }),
        execute: async () => fixture('wiki-read-ok'),
      }),
    },
  });
  const httpServer = createServer((req, res) => {
    void mcpServer.startHTTP({ url: new URL(req.url ?? '/', `http://${req.headers.host}`), httpPath: '/mcp', req, res });
  });

  try {
    await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen));
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const configPath = resolve(directory, 'external.json');
    await writeFile(configPath, JSON.stringify({
      transport: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      products: [{ business_line: 'cloudlearn', product_id: 'demo', terms: ['Demo'] }],
    }));
    const capability = new CapabilityMcp({ projectRoot, externalKnowledgeConfigFile: configPath } as RuntimeConfig);
    const session = await capability.createExternalKnowledgeTools(['Demo 登录失败']);
    assert.ok(session?.client);
    const resolveTool = session!.tools.resolve_external_knowledge as unknown as {
      execute(input: { query: string }, context: unknown): Promise<Record<string, unknown>>;
    };
    const result = await resolveTool.execute({ query: 'Demo 登录失败' }, {});
    const resolved = result.result as { status: string; candidates: Array<{ business_line: string; product_id: string; topic_id: string; recommended_sections: Array<{ section_id: string }> }> };
    assert.equal(resolved.status, 'resolved');
    const candidate = resolved.candidates[0];
    const readTool = session!.tools.read_external_knowledge as unknown as {
      execute(input: { business_line: string; product_id: string; topic_id: string; section_ids: string[] }, context: unknown): Promise<Record<string, unknown>>;
    };
    const read = await readTool.execute({
      business_line: candidate.business_line,
      product_id: candidate.product_id,
      topic_id: candidate.topic_id,
      section_ids: [candidate.recommended_sections[0].section_id],
    }, {});
    assert.equal((read.result as { status: string }).status, 'ok');
    await session!.client?.disconnect();
  } finally {
    await new Promise<void>((resolveClose, reject) => httpServer.close((error) => error ? reject(error) : resolveClose()));
    await mcpServer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
