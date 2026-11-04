import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';

import { loadRuntimeConfig } from '../src/config.js';
import { migrateLegacyData, rollbackLegacyMigration } from '../src/migration/legacy.js';

async function fixture(createDataDir = true) {
  const root = await mkdtemp(join(tmpdir(), 'troubleshoot-migration-'));
  const dataDir = join(root, 'new-data');
  const legacyDir = join(root, 'legacy');
  const snapshotDir = join(legacyDir, 'workspaces', 'repo-1', 'abc123');
  const conversations = join(legacyDir, 'conversations.json');
  const repositories = join(legacyDir, 'repositories.json');
  const modelConfig = join(legacyDir, 'model-config.json');
  const databaseUrl = `file:${join(dataDir, 'runtime.db')}`;
  const now = '2026-09-24T08:10:07.817750+00:00';

  await import('node:fs/promises').then(({ mkdir }) => mkdir(snapshotDir, { recursive: true }));
  if (createDataDir) await import('node:fs/promises').then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
  await writeFile(conversations, JSON.stringify([{
    id: 'conv-legacy',
    title: 'legacy',
    messages: [{ id: 'msg-1', role: 'user', content: '白屏', created_at: now }],
    messages_state: [{ part_kind: 'user-prompt', content: '白屏' }],
    evidence_state: { entries: [] },
    created_at: now,
    updated_at: now,
  }]));
  await writeFile(repositories, JSON.stringify([{
    id: 'repo-1', name: 'demo', url: 'file:///tmp/demo.git', default_branch: 'main',
    created_at: now, updated_at: now,
  }]));
  await writeFile(join(snapshotDir, '.harmony-agent-snapshot.json'), JSON.stringify({
    repository_id: 'repo-1', repository_name: 'demo', requested_ref: 'main',
    resolved_commit: 'abc123', workspace_path: snapshotDir, created_at: now,
  }));
  await writeFile(modelConfig, JSON.stringify({ provider: 'openai', model_name: 'gpt-test', api_key: 'secret' }));
  await chmod(modelConfig, 0o600);

  const config = loadRuntimeConfig({
    HARMONY_MASTRA_DATA_DIR: dataDir,
    HARMONY_MASTRA_DATABASE_URL: databaseUrl,
    HARMONY_MASTRA_LEGACY_CONVERSATIONS_FILE: conversations,
    HARMONY_MASTRA_LEGACY_REPOSITORIES_FILE: repositories,
    HARMONY_MASTRA_LEGACY_SNAPSHOT_DIR: join(legacyDir, 'workspaces'),
    HARMONY_AGENT_MODEL_CONFIG_FILE: modelConfig,
  });
  return { root, dataDir, config, conversations, repositories, modelConfig };
}

test('legacy migration creates a missing target directory on first apply', async () => {
  const state = await fixture(false);
  await assert.rejects(access(state.dataDir), { code: 'ENOENT' });

  const applied = await migrateLegacyData(state.config, 'apply');

  await access(join(state.dataDir, 'runtime.db'));
  assert.deepEqual(applied.imported, { conversation: 1, repository: 1, snapshot: 1 });
  assert.equal(applied.rejected.length, 0);
});

test('legacy migration dry-run is side-effect free and apply is idempotent', async () => {
  const state = await fixture();
  const dry = await migrateLegacyData(state.config, 'dry-run');
  assert.deepEqual(dry.imported, { conversation: 1, repository: 1, snapshot: 1 });
  assert.equal(dry.backups.length, 0);
  assert.equal(JSON.parse(await readFile(state.conversations, 'utf8')).length, 1);

  const applied = await migrateLegacyData(state.config, 'apply');
  assert.equal(applied.backups.length, 3);
  assert.equal(applied.model_config_preserved, true);
  assert.equal((await readFile(state.modelConfig)).toString().includes('secret'), true);

  const repeated = await migrateLegacyData(state.config, 'apply');
  assert.equal(repeated.no_op, true);
  assert.equal(repeated.migration_id, applied.migration_id);
});

test('rollback restores imported rows and refuses changed rows', async () => {
  const state = await fixture();
  const applied = await migrateLegacyData(state.config, 'apply');
  const client = createClient({ url: state.config.databaseUrl });
  await client.execute({
    sql: 'UPDATE product_conversations SET data = ?, record_hash = ? WHERE id = ?',
    args: ['{"id":"conv-legacy","changed":true}', 'changed', 'conv-legacy'],
  });
  client.close();

  const rolled = await rollbackLegacyMigration(state.config, applied.migration_id);
  assert.deepEqual(rolled.rollback_conflicts, [{
    entity: 'conversation', id: 'conv-legacy', reason: 'record changed after migration; left intact',
  }]);
  assert.equal(rolled.rollback_conflicts?.length, 1);
  const verificationClient = createClient({ url: state.config.databaseUrl });
  const migration = await verificationClient.execute({
    sql: 'SELECT status FROM runtime_migrations WHERE migration_id = ?',
    args: [applied.migration_id],
  });
  verificationClient.close();
  assert.equal(migration.rows[0]?.status, 'rollback_partial');
});

test('rollback removes unchanged imported rows and leaves the legacy source intact', async () => {
  const state = await fixture();
  const originalConversations = await readFile(state.conversations, 'utf8');
  const applied = await migrateLegacyData(state.config, 'apply');
  const client = createClient({ url: state.config.databaseUrl });
  const schema = await client.execute("SELECT version FROM runtime_schema WHERE name = 'product-data'");
  assert.equal(schema.rows[0]?.version, 1);

  const rolled = await rollbackLegacyMigration(state.config, applied.migration_id);
  const counts = await Promise.all([
    client.execute('SELECT COUNT(*) AS count FROM product_conversations'),
    client.execute('SELECT COUNT(*) AS count FROM product_repositories'),
    client.execute('SELECT COUNT(*) AS count FROM product_snapshots'),
  ]);
  client.close();

  assert.deepEqual(rolled.rollback_conflicts, []);
  assert.deepEqual(counts.map((result) => Number(result.rows[0]?.count)), [0, 0, 0]);
  assert.equal(await readFile(state.conversations, 'utf8'), originalConversations);
});

test('changed legacy source cannot overwrite a conversation already changed in Mastra', async () => {
  const state = await fixture();
  await migrateLegacyData(state.config, 'apply');

  const client = createClient({ url: state.config.databaseUrl });
  await client.execute({
    sql: 'UPDATE product_conversations SET data = ? WHERE id = ?',
    args: ['{"id":"conv-legacy","title":"new runtime state"}', 'conv-legacy'],
  });
  client.close();

  const legacy = JSON.parse(await readFile(state.conversations, 'utf8')) as Array<Record<string, unknown>>;
  legacy[0]!.title = 'changed legacy state';
  await writeFile(state.conversations, JSON.stringify(legacy));

  await assert.rejects(
    () => migrateLegacyData(state.config, 'apply'),
    /migration target contains different records: conversation:conv-legacy/,
  );
});
