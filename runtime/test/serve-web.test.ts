import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { APP_PREFIX, createTestRuntime } from './auth-helpers.js';

describe('serveWeb static assets', () => {
  let dataDir = '';
  let projectRoot = '';

  after(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  });

  test('serves Vite assets under app prefix with JS content-type', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'serve-web-data-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'serve-web-root-'));
    await mkdir(join(projectRoot, 'skills'), { recursive: true });
    await mkdir(join(projectRoot, 'mcp_server'), { recursive: true });
    await mkdir(join(projectRoot, 'runtime/contracts'), { recursive: true });
    await mkdir(join(projectRoot, 'web/dist/assets'), { recursive: true });
    await writeFile(
      join(projectRoot, 'runtime/contracts/server-signals.yaml'),
      'version: 1\nserviceNames: []\napiPrefixes: []\nerrorCodePatterns: []\n',
    );
    await writeFile(join(projectRoot, 'web/dist/index.html'), '<script type="module" src="/xesapp-agent/assets/index-test.js"></script>');
    await writeFile(join(projectRoot, 'web/dist/assets/index-test.js'), 'export const ok = 1;\n');

    const { app, mastra, store } = await createTestRuntime(dataDir, {
      HARMONY_MASTRA_PROJECT_ROOT: projectRoot,
      HARMONY_MASTRA_SERVE_WEB: 'true',
      HARMONY_MASTRA_WEB_DIST: 'web/dist',
    });

    try {
      const asset = await app.request(`${APP_PREFIX}/assets/index-test.js`);
      assert.equal(asset.status, 200);
      const contentType = asset.headers.get('content-type') || '';
      assert.match(contentType, /javascript|ecmascript/i);
      assert.match(await asset.text(), /export const ok/);

      const page = await app.request(`${APP_PREFIX}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') || '', /text\/html/i);
    } finally {
      await store.close();
      await mastra.getStorage()?.close();
    }
  });
});
