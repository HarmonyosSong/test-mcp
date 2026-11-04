import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

const server = new MCPServer({
  id: 'external-knowledge-fixture',
  name: 'External Knowledge Fixture',
  version: '1.0.0',
  tools: {
    wiki_resolve: createTool({
      id: 'wiki_resolve',
      description: 'Fixture external resolver',
      inputSchema: z.object({ query: z.string(), business_line: z.string(), product_id: z.string(), limit: z.number() }),
      execute: async ({ query }) => {
        const sample = JSON.parse(await readFile(resolve('runtime/contracts/dev-knowledge/examples/wiki-resolve-ok.json'), 'utf8'));
        return { ...sample.response, query };
      },
    }),
    wiki_read: createTool({
      id: 'wiki_read',
      description: 'Fixture external reader',
      inputSchema: z.object({ business_line: z.string(), product_id: z.string(), topic_id: z.string(), section_ids: z.array(z.string()) }),
      execute: async () => {
        const sample = JSON.parse(await readFile(resolve('runtime/contracts/dev-knowledge/examples/wiki-read-ok.json'), 'utf8'));
        return sample.response;
      },
    }),
    unrelated_tool: createTool({
      id: 'unrelated_tool',
      description: 'Must not be exposed to the diagnosis agent',
      inputSchema: z.object({}),
      execute: async () => 'not available',
    }),
  },
});

await server.startStdio();
