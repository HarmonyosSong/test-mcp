import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { loadRuntimeConfig } from '../src/config.js';

const PROJECT_ROOT = '/tmp/troubleshoot-odyssey-data-root-test';

test('defaults data paths under projectRoot/.data when DATA_ROOT is unset', () => {
  const config = loadRuntimeConfig({
    HARMONY_MASTRA_PROJECT_ROOT: PROJECT_ROOT,
  });
  const dataRoot = resolve(PROJECT_ROOT, '.data');
  assert.equal(config.dataDir, resolve(dataRoot, 'mastra'));
  assert.equal(config.gitMirrorDir, resolve(dataRoot, 'git-mirrors'));
  assert.equal(config.snapshotDir, resolve(dataRoot, 'workspaces'));
  assert.equal(config.legacySnapshotDir, resolve(dataRoot, 'workspaces'));
  assert.equal(config.modelConfigFile, resolve(dataRoot, 'model-config.json'));
  assert.equal(config.knowledgeQueryLog, resolve(dataRoot, 'knowledge-queries.jsonl'));
  assert.equal(config.caseArchiveDir, resolve(dataRoot, 'knowledge-cases'));
  assert.equal(config.mastraObservabilityDir, resolve(dataRoot, 'mastra', 'observability'));
  assert.equal(config.legacyConversationsFile, resolve(dataRoot, 'conversations.json'));
  assert.equal(config.legacyRepositoriesFile, resolve(dataRoot, 'repositories.json'));
  assert.equal(config.databaseUrl, `file:${resolve(dataRoot, 'mastra', 'runtime.db')}`);
});

test('absolute DATA_ROOT derives all runtime data paths', () => {
  const dataRoot = '/data/troubleshoot-odyssey';
  const config = loadRuntimeConfig({
    HARMONY_MASTRA_PROJECT_ROOT: PROJECT_ROOT,
    HARMONY_AGENT_DATA_ROOT: dataRoot,
  });
  assert.equal(config.dataDir, resolve(dataRoot, 'mastra'));
  assert.equal(config.gitMirrorDir, resolve(dataRoot, 'git-mirrors'));
  assert.equal(config.snapshotDir, resolve(dataRoot, 'workspaces'));
  assert.equal(config.modelConfigFile, resolve(dataRoot, 'model-config.json'));
  assert.equal(config.knowledgeQueryLog, resolve(dataRoot, 'knowledge-queries.jsonl'));
  assert.equal(config.caseArchiveDir, resolve(dataRoot, 'knowledge-cases'));
  assert.equal(config.databaseUrl, `file:${resolve(dataRoot, 'mastra', 'runtime.db')}`);
});

test('explicit path overrides beat DATA_ROOT derivation', () => {
  const dataRoot = '/data/troubleshoot-odyssey';
  const config = loadRuntimeConfig({
    HARMONY_MASTRA_PROJECT_ROOT: PROJECT_ROOT,
    HARMONY_AGENT_DATA_ROOT: dataRoot,
    HARMONY_MASTRA_DATA_DIR: '.data/mastra',
    HARMONY_AGENT_MODEL_CONFIG_FILE: '.data/model-config.json',
  });
  assert.equal(config.dataDir, resolve(PROJECT_ROOT, '.data/mastra'));
  assert.equal(config.modelConfigFile, resolve(PROJECT_ROOT, '.data/model-config.json'));
  assert.equal(config.gitMirrorDir, resolve(dataRoot, 'git-mirrors'));
});
