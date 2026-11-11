import { existsSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { loadRuntimeConfig } from './config.js';
import { createRuntimeApp } from './app.js';
import { isCompassA2AConfigured } from './capabilities/compass-a2a.js';
import { isLogCenterConfigured, logCatalogPath } from './capabilities/log-center.js';
import { integrationInfo, integrationWarn } from './observability/integration-log.js';
import { drainHttpServer } from './shutdown.js';

const config = loadRuntimeConfig();
const { app, mastra, store, capabilities, yachChannel } = await createRuntimeApp(config);

const catalogPath = logCatalogPath(config);
const catalogExists = existsSync(catalogPath);
integrationInfo('auth', 'startup auth mode', {
  runMode: config.runMode,
  authMode: config.authMode,
  publicBaseUrl: config.publicBaseUrl || '(empty)',
  ssoConfigured: Boolean(config.ssoBaseUrl && config.ssoAppId && config.ssoAppKey),
});
integrationInfo('logcenter', 'startup config', {
  credentialsConfigured: isLogCenterConfigured(config),
  baseUrl: config.logcenterBaseUrl,
  catalogPath,
  catalogExists,
});
if (isLogCenterConfigured(config) && !catalogExists) {
  integrationWarn('logcenter', 'credentials present but catalog file missing; tools will fail to mount', {
    catalogPath,
  });
}
integrationInfo('a2a', 'startup config', {
  configured: isCompassA2AConfigured(config.a2aToken),
  baseUrl: config.a2aBaseUrl,
  clientId: config.a2aClientId,
  waitSeconds: config.a2aWaitSeconds,
  debugProvider: config.a2aDebugEnabled,
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Mastra runtime listening on http://${info.address}:${info.port}`);
  if (yachChannel) {
    yachChannel.start();
    console.log('Yach digital-partner IM channel started');
  }
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => {
  shutdownPromise ??= drainHttpServer(server, async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => yachChannel?.close()),
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
