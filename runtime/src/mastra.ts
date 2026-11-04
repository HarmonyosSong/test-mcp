import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { LibSQLStore } from '@mastra/libsql';
import { Mastra } from '@mastra/core/mastra';
import type { RuntimeConfig } from './config.js';

export function createMastra(config: RuntimeConfig): Mastra {
  mkdirSync(resolve(config.dataDir), { recursive: true });
  chmodSync(resolve(config.dataDir), 0o700);
  return new Mastra({
    agents: {},
    logger: false,
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
