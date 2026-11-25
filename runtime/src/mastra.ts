import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { LibSQLStore } from '@mastra/libsql';
import { Mastra } from '@mastra/core/mastra';
import { Observability, SensitiveDataFilter } from '@mastra/observability';
import type { RuntimeConfig } from './config.js';
import { ConversationSpanFileExporter, registerConversationEventSink } from './observability/conversation-span-file-exporter.js';

function createFileObservability(rootDir: string, contentLimit: number): Observability {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  chmodSync(rootDir, 0o700);
  // 会话时间线事件（协查发起/回执等编排事实）与 trace 落同一棵目录树。
  registerConversationEventSink(rootDir);
  return new Observability({
    configs: {
      default: {
        serviceName: 'troubleshoot-odyssey',
        exporters: [new ConversationSpanFileExporter(rootDir, contentLimit)],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  });
}

export function createMastra(config: RuntimeConfig): Mastra {
  mkdirSync(resolve(config.dataDir), { recursive: true });
  chmodSync(resolve(config.dataDir), 0o700);
  const enabled = config.mastraObservabilityConsole;
  return new Mastra({
    agents: {},
    // Quiet terminal: span dumps go to per-conversation JSON files, not stdout.
    logger: false,
    storage: new LibSQLStore({
      id: 'troubleshoot-odyssey-runtime',
      url: config.databaseUrl,
    }),
    ...(enabled
      ? {
          observability: createFileObservability(
            config.mastraObservabilityDir,
            config.mastraObservabilityPreviewChars,
          ),
        }
      : {}),
    server: {
      host: config.host,
      port: config.port,
      drainTimeout: 240_000,
    },
  });
}
