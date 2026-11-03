import { serve } from '@hono/node-server';
import { loadRuntimeConfig } from './config.js';
import { createRuntimeApp } from './app.js';

const config = loadRuntimeConfig();
const { app, mastra, store, capabilities } = await createRuntimeApp(config);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Mastra runtime listening on http://${info.address}:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await store.close();
  await capabilities.close();
  await mastra.getStorage()?.close();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
