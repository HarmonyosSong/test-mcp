import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { LibSQLStore } from '@mastra/libsql';
import { Mastra } from '@mastra/core/mastra';

import type { RuntimeConfig } from './config.js';

export function createMastra(config: RuntimeConfig): Mastra {
  mkdirSync(resolve(config.dataDir), { recursive: true });
  return new Mastra({
    storage: new LibSQLStore({
      id: 'troubleshoot-odyssey-runtime',
      url: config.databaseUrl,
    }),
    server: {
      host: config.host,
      port: config.port,
      drainTimeout: 240_000,
    },
  });
}
