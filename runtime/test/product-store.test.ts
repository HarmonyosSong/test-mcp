import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';

import { loadRuntimeConfig } from '../src/config.js';
import { createRuntimeDatabase } from '../src/migration/legacy.js';
import { ProductNotFoundError, ProductStore } from '../src/product/store.js';

test('product store owns conversation CRUD and repairs stale streaming messages', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'troubleshoot-product-store-'));
  const config = loadRuntimeConfig({
    HARMONY_MASTRA_DATA_DIR: dataDir,
    HARMONY_MASTRA_DATABASE_URL: `file:${join(dataDir, 'runtime.db')}`,
  });
  const client = createRuntimeDatabase(config);
  const store = new ProductStore(client);
  await store.createConversation({
    id: 'conv-store',
    title: 'store test',
    messages: [{
      id: 'user-1', role: 'user', content: '白屏', status: 'completed', steps: [],
      error: null, report: null, input_tokens: null, output_tokens: null, tool_usage: {},
      created_at: '2026-11-03T00:00:00.000Z',
    }, {
      id: 'assistant-1', role: 'assistant', content: '半截', status: 'streaming', steps: [],
      error: null, report: null, input_tokens: null, output_tokens: null, tool_usage: {},
      created_at: '2026-11-03T00:00:01.000Z',
    }],
  });
  await client.close();

  const restarted = new ProductStore(createClient({ url: config.databaseUrl }));
  const recovered = await restarted.getConversation('conv-store');
  assert.equal(recovered.messages[1]?.status, 'failed');
  assert.equal(recovered.messages[1]?.report, null);
  assert.deepEqual((await restarted.listConversations())[0], {
    id: 'conv-store', title: 'store test', repository_name: null, message_count: 2,
    updated_at: recovered.updated_at,
  });
  await assert.rejects(() => restarted.getConversation('missing'), ProductNotFoundError);
  await restarted.deleteConversation('conv-store');
  await restarted.close();
  await rm(dataDir, { recursive: true, force: true });
});
