import { Hono } from 'hono';
import { MastraServer } from '@mastra/hono';
import type { RuntimeConfig } from './config.js';
import { createMastra } from './mastra.js';

export interface RuntimeApp {
  app: Hono;
  mastra: ReturnType<typeof createMastra>;
  adapter: MastraServer;
}

export async function createRuntimeApp(config: RuntimeConfig): Promise<RuntimeApp> {
  const mastra = createMastra(config);
  const app = new Hono();
  const adapter = new MastraServer({ app, mastra });
  await adapter.init();

  app.get('/api/health', (context) =>
    context.json({ status: 'ok', runtime: 'mastra', version: '0.1.0' }),
  );

  app.get('/api/meta', (context) =>
    context.json({ runtime: 'mastra', agent: null, phase: 'foundation' }),
  );

  return { app, mastra, adapter };
}
