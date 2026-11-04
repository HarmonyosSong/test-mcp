import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CapabilityMcp } from '../src/capabilities/mcp.js';
import type { RuntimeConfig } from '../src/config.js';

type RetrievalCase = { split: string; query: string; expected: string | null };
type LookupResult = { hits?: Array<{ name: string }>; retrieval_status?: string };

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Mastra MCP lookup preserves the legacy retrieval examples without negative matches', async () => {
  const datasetPath = resolve(projectRoot, 'experiments/knowledge_audit/datasets/legacy-knowledge-retrieval.jsonl');
  const cases = (await readFile(datasetPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as RetrievalCase);
  const directory = await mkdtemp(resolve(tmpdir(), 'mastra-knowledge-regression-'));
  const config = {
    projectRoot,
    knowledgeRoot: 'knowledge',
    knowledgeQueryLog: resolve(directory, 'queries.jsonl'),
    knowledgeRetrievalMode: undefined,
    knowledgePreviewStrategy: undefined,
    mcpCommand: 'uv',
  } as RuntimeConfig;
  const session = await new CapabilityMcp(config).createKnowledgeSession('retrieval-regression', 'dataset');
  assert.ok(session, 'knowledge MCP must start for retrieval regression');

  try {
    const lookup = (session.toolsets.knowledge as Record<string, {
      execute?: (input: { query: string }, context: unknown) => Promise<LookupResult>;
    }>).lookup_issue;
    assert.equal(typeof lookup?.execute, 'function');
    for (const item of cases) {
      const result = await lookup!.execute!({ query: item.query }, {});
      const names = (result.hits ?? []).map(({ name }) => name);
      if (item.expected) {
        assert.ok(names.includes(item.expected), `${item.split}: ${item.query} expected ${item.expected}, got ${names.join(', ')}`);
      } else {
        assert.equal(names.length, 0, `${item.split}: ${item.query} unexpectedly matched ${names.join(', ')}`);
      }
    }
    assert.equal(cases.length, 24);
  } finally {
    await session.client.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
