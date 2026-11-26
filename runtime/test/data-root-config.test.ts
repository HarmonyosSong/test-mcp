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
});

test('COS 未启用时 COS_PREFIX 形态不参与校验（不击穿启动）', () => {
  const config = loadRuntimeConfig({
    HARMONY_MASTRA_PROJECT_ROOT: PROJECT_ROOT,
    COS_SECRET_ID: '',
    COS_SECRET_KEY: '',
    COS_REGION: '',
    COS_BUCKET: '',
    COS_PREFIX: '///bad/../prefix///',
  });
  // 原样裁斜线后保留，不做形态报错。
  assert.equal(config.cosPrefix, 'bad/../prefix');
});

test('COS 启用时 COS_PREFIX 形态必校验', () => {
  assert.throws(
    () => loadRuntimeConfig({
      HARMONY_MASTRA_PROJECT_ROOT: PROJECT_ROOT,
      COS_SECRET_ID: 'secret-id',
      COS_SECRET_KEY: 'secret-key',
      COS_REGION: 'ap-beijing',
      COS_BUCKET: 'bucket-1250000000',
      COS_PREFIX: 'bad/../prefix',
    }),
    /COS_PREFIX/,
  );
});
