import { serve } from '@hono/node-server';
import { loadRuntimeConfig } from './config.js';
import { createRuntimeApp } from './app.js';
import { drainHttpServer } from './shutdown.js';

const config = loadRuntimeConfig();
const { app, mastra, store, capabilities } = await createRuntimeApp(config);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Mastra runtime listening on http://${info.address}:${info.port}`);
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => {
  shutdownPromise ??= drainHttpServer(server, async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.close()),
      Promise.resolve().then(() => capabilities.close()),
      Promise.resolve().then(() => mastra.getStorage()?.close()),
    ]);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'runtime resource shutdown failed');
  });
  return shutdownPromise;
};

const onSignal = () => {
  void shutdown().catch(() => {
    console.error('Runtime shutdown failed');
    process.exitCode = 1;
  });
};

process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
