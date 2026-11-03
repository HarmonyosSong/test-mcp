import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRuntimeConfig } from '../src/config.js';
import { createRuntimeApp } from '../src/app.js';

test('loads safe defaults and exposes health metadata', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'troubleshoot-odyssey-'));
  try {
    const config = loadRuntimeConfig({ HARMONY_MASTRA_DATA_DIR: dataDir });
    const { app, mastra } = await createRuntimeApp(config);
    const response = await app.request('/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      runtime: 'mastra',
      version: '0.1.0',
    });

    const memory = await mastra.getStorage()?.getStore('memory');
    assert.ok(memory);
    const thread = {
      id: 'foundation-restart-check',
      title: 'persistence check',
      resourceId: 'foundation-test',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await memory.saveThread({ thread });
    await mastra.getStorage()?.close();

    const restarted = await createRuntimeApp(config);
    const restartedMemory = await restarted.mastra.getStorage()?.getStore('memory');
    assert.equal(
      (await restartedMemory?.getThreadById({ threadId: thread.id }))?.resourceId,
      thread.resourceId,
    );
    await restarted.mastra.getStorage()?.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('rejects invalid ports before server startup', () => {
  assert.throws(
    () => loadRuntimeConfig({ HARMONY_MASTRA_PORT: '70000' }),
    /Too big|greater than or equal to 1|maximum/i,
  );
});
