import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { createClient, type Client, type Transaction } from '@libsql/client';
import type { z } from 'zod';

import type { RuntimeConfig } from '../config.js';
import {
  ConversationRecordSchema,
  RepositoryRecordSchema,
  RepositorySnapshotSchema,
  type ConversationRecord,
} from '../domain/schemas.js';

type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;
type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;

type Entity = 'conversation' | 'repository' | 'snapshot';
type ImportRow = { entity: Entity; id: string; value: unknown; source: string; index: number };
type RejectedRow = { source: string; index: number; error: string };

export interface MigrationReport {
  mode: 'dry-run' | 'apply' | 'rollback';
  migration_id: string;
  source_hash: string;
  imported: Record<Entity, number>;
  rejected: RejectedRow[];
  backups: string[];
  no_op?: boolean;
  rollback_conflicts?: Array<{ entity: Entity; id: string; reason: string }>;
  model_config_preserved: boolean;
}

const entityTables: Record<Entity, string> = {
  conversation: 'product_conversations',
  repository: 'product_repositories',
  snapshot: 'product_snapshots',
};

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function rowKey(entity: Entity, id: string): string {
  return `${entity}:${id}`;
}

function initialReport(mode: MigrationReport['mode'], sourceHash: string): MigrationReport {
  return {
    mode,
    migration_id: `legacy-${sourceHash.slice(0, 24)}`,
    source_hash: sourceHash,
    imported: { conversation: 0, repository: 0, snapshot: 0 },
    rejected: [],
    backups: [],
    model_config_preserved: false,
  };
}

export function createRuntimeDatabase(config: RuntimeConfig): Client {
  return createClient({ url: config.databaseUrl });
}

export async function ensureProductSchema(client: Client): Promise<void> {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS product_conversations (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS product_repositories (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS product_snapshots (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS runtime_migrations (
      migration_id TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      source_manifest TEXT NOT NULL,
      report TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS runtime_migration_items (
      migration_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      previous_data TEXT,
      imported_hash TEXT NOT NULL,
      PRIMARY KEY (migration_id, entity, entity_id)
    )`,
    `CREATE TABLE IF NOT EXISTS runtime_schema (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ]);
  await client.execute({
    sql: `INSERT OR IGNORE INTO runtime_schema (name, version, updated_at) VALUES (?, ?, ?)`,
    args: ['product-data', 1, new Date().toISOString()],
  });
}

async function readJson(path: string): Promise<{ exists: boolean; value?: unknown; bytes?: Buffer }> {
  try {
    const bytes = await readFile(path);
    return { exists: true, value: JSON.parse(bytes.toString('utf8')), bytes };
  } catch (error) {
    if (isNotFound(error)) return { exists: false };
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function findSnapshotFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === '.harmony-agent-snapshot.json') result.push(path);
    }
  };
  await visit(root);
  return result.sort();
}

async function collectSources(config: RuntimeConfig) {
  const conversations = resolve(config.legacyConversationsFile);
  const repositories = resolve(config.legacyRepositoriesFile);
  const snapshotFiles = await findSnapshotFiles(resolve(config.legacySnapshotDir));
  const sourceFiles = [conversations, repositories, ...snapshotFiles].sort();
  const fileParts: Array<{ path: string; exists: boolean; bytes?: Buffer; value?: unknown }> = [];
  for (const path of sourceFiles) {
    const item = await readJson(path);
    fileParts.push({ path, ...item });
  }
  const canonical = fileParts.map((item) => ({
    path: item.path,
    exists: item.exists,
    hash: item.bytes ? digest(item.bytes) : null,
  }));
  return {
    conversationsPath: conversations,
    repositoriesPath: repositories,
    snapshotFiles,
    fileParts,
    sourceManifest: canonical,
    sourceHash: digest(encode(canonical)),
  };
}

function collectRows(sources: Awaited<ReturnType<typeof collectSources>>) {
  const rows: ImportRow[] = [];
  const rejected: RejectedRow[] = [];
  const conversationSource = sources.fileParts.find((item) => item.path === sources.conversationsPath);
  const repositorySource = sources.fileParts.find((item) => item.path === sources.repositoriesPath);

  function parseArray<T>(
    source: (typeof sources.fileParts)[number] | undefined,
    entity: Entity,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } } },
  ) {
    if (!source?.exists) return;
    if (!Array.isArray(source.value)) {
      rejected.push({ source: source.path, index: -1, error: 'expected a JSON array' });
      return;
    }
    source.value.forEach((raw, index) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({
          source: source.path,
          index,
          error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        });
        return;
      }
      const record = parsed.data as T & { id: string };
      rows.push({ entity, id: record.id, value: record, source: source.path, index });
    });
  }

  parseArray<ConversationRecord>(conversationSource, 'conversation', ConversationRecordSchema);
  parseArray<RepositoryRecord>(repositorySource, 'repository', RepositoryRecordSchema);

  for (const path of sources.snapshotFiles) {
    const source = sources.fileParts.find((item) => item.path === path);
    if (!source?.exists) continue;
    const parsed = RepositorySnapshotSchema.safeParse(source.value);
    if (!parsed.success) {
      rejected.push({
        source: path,
        index: 0,
        error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      });
      continue;
    }
    const value = parsed.data;
    rows.push({
      entity: 'snapshot',
      id: `${value.repository_id}:${value.resolved_commit}`,
      value,
      source: path,
      index: 0,
    });
  }

  const seen = new Map<string, ImportRow>();
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const key = rowKey(row.entity, row.id);
    const duplicate = seen.get(key);
    if (duplicate) {
      rejected.push({
        source: row.source,
        index: row.index,
        error: `duplicate ${row.entity} id ${row.id} also appears in ${duplicate.source}`,
      });
      rows.splice(index, 1);
    } else {
      seen.set(key, row);
    }
  }
  return { rows, rejected };
}

async function createBackups(
  paths: string[],
  dataDir: string,
  migrationId: string,
): Promise<string[]> {
  const backupDir = resolve(dataDir, 'backups', `${new Date().toISOString().replaceAll(':', '-')}-${migrationId}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const output: string[] = [];
  for (const path of paths) {
    try {
      await stat(path);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    const target = join(backupDir, `${digest(path).slice(0, 10)}-${basename(path)}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path, target);
    output.push(target);
  }
  await writeFileExclusive(join(backupDir, 'manifest.json'), encode({ migration_id: migrationId, files: paths }));
  return output;
}

async function writeFileExclusive(path: string, content: string): Promise<void> {
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

async function currentEntityData(transaction: Transaction, entity: Entity, id: string): Promise<string | null> {
  const table = entityTables[entity];
  const result = await transaction.execute({
    sql: `SELECT data FROM ${table} WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  return row && typeof row.data === 'string' ? row.data : null;
}

async function findTargetConflicts(client: Client, rows: ImportRow[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const row of rows) {
    const existing = await client.execute({
      sql: `SELECT data FROM ${entityTables[row.entity]} WHERE id = ?`,
      args: [row.id],
    });
    const data = existing.rows[0]?.data;
    if (typeof data === 'string' && data !== encode(row.value)) {
      conflicts.push(`${row.entity}:${row.id}`);
    }
  }
  return conflicts;
}

async function applyRows(
  transaction: Transaction,
  migrationId: string,
  rows: ImportRow[],
): Promise<void> {
  for (const row of rows) {
    const table = entityTables[row.entity];
    const data = encode(row.value);
    const hash = digest(data);
    const previous = await currentEntityData(transaction, row.entity, row.id);
    await transaction.execute({
      sql: `INSERT INTO ${table} (id, data, record_hash, ${row.entity === 'snapshot' ? 'created_at' : 'updated_at'})
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, record_hash = excluded.record_hash,
              ${row.entity === 'snapshot' ? 'created_at' : 'updated_at'} = excluded.${row.entity === 'snapshot' ? 'created_at' : 'updated_at'}`,
      args: [row.id, data, hash, String((row.value as { updated_at?: string; created_at?: string }).updated_at ?? (row.value as { created_at?: string }).created_at ?? '')],
    });
    await transaction.execute({
      sql: `INSERT INTO runtime_migration_items (migration_id, entity, entity_id, previous_data, imported_hash)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(migration_id, entity, entity_id) DO UPDATE SET
              previous_data = excluded.previous_data, imported_hash = excluded.imported_hash`,
      args: [migrationId, row.entity, row.id, previous, hash],
    });
  }
}

export async function migrateLegacyData(
  config: RuntimeConfig,
  mode: 'dry-run' | 'apply',
): Promise<MigrationReport> {
  const sources = await collectSources(config);
  const { rows, rejected } = collectRows(sources);
  const report = initialReport(mode, sources.sourceHash);
  report.rejected = rejected;
  report.model_config_preserved = await readJson(resolve(config.modelConfigFile)).then((item) => item.exists);
  for (const row of rows) report.imported[row.entity]++;
  if (mode === 'dry-run') return report;

  const client = createRuntimeDatabase(config);
  try {
    await ensureProductSchema(client);
    const existing = await client.execute({
      sql: 'SELECT status, report FROM runtime_migrations WHERE migration_id = ?',
      args: [report.migration_id],
    });
    if (existing.rows[0]) {
      const previous = JSON.parse(String(existing.rows[0].report)) as MigrationReport;
      return { ...previous, mode: 'apply', no_op: true };
    }

    const targetConflicts = await findTargetConflicts(client, rows);
    if (targetConflicts.length > 0) {
      throw new Error(`migration target contains different records: ${targetConflicts.join(', ')}`);
    }

    const backupPaths = [sources.conversationsPath, sources.repositoriesPath, ...sources.snapshotFiles];
    report.backups = await createBackups(backupPaths, config.dataDir, report.migration_id);
    const transaction = await client.transaction('write');
    try {
      await applyRows(transaction, report.migration_id, rows);
      for (const item of rejected) {
        await transaction.execute({
          sql: 'INSERT INTO runtime_migration_items (migration_id, entity, entity_id, previous_data, imported_hash) VALUES (?, ?, ?, ?, ?)',
          args: [report.migration_id, 'rejected', `${item.source}#${item.index}`, null, digest(item.error)],
        });
      }
      const status = rejected.length ? 'partial' : 'complete';
      await transaction.execute({
        sql: `INSERT INTO runtime_migrations (migration_id, source_hash, status, source_manifest, report, applied_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [report.migration_id, report.source_hash, status, encode(sources.sourceManifest), encode(report), new Date().toISOString()],
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
    return report;
  } finally {
    client.close();
  }
}

export async function rollbackLegacyMigration(
  config: RuntimeConfig,
  migrationId: string,
): Promise<MigrationReport> {
  const client = createRuntimeDatabase(config);
  const report = initialReport('rollback', '');
  report.migration_id = migrationId;
  report.rollback_conflicts = [];
  try {
    await ensureProductSchema(client);
    const migration = await client.execute({
      sql: 'SELECT source_hash, report FROM runtime_migrations WHERE migration_id = ?',
      args: [migrationId],
    });
    const migrationRow = migration.rows[0];
    if (!migrationRow) throw new Error(`migration not found: ${migrationId}`);
    report.source_hash = String(migrationRow.source_hash);
    report.backups = ((JSON.parse(String(migrationRow.report)) as MigrationReport).backups ?? []);
    const items = await client.execute({
      sql: `SELECT entity, entity_id, previous_data, imported_hash FROM runtime_migration_items
            WHERE migration_id = ? AND entity IN ('conversation', 'repository', 'snapshot')`,
      args: [migrationId],
    });
    const transaction = await client.transaction('write');
    try {
      for (const item of items.rows) {
        const entity = String(item.entity) as Entity;
        const id = String(item.entity_id);
        const current = await currentEntityData(transaction, entity, id);
        if (current === null || digest(current) !== String(item.imported_hash)) {
          report.rollback_conflicts!.push({ entity, id, reason: 'record changed after migration; left intact' });
          continue;
        }
        const table = entityTables[entity];
        if (item.previous_data === null) {
          await transaction.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] });
        } else {
          const previousData = String(item.previous_data);
          const previousHash = digest(previousData);
          const parsed = JSON.parse(previousData) as { created_at?: string; updated_at?: string };
          await transaction.execute({
            sql: `UPDATE ${table} SET data = ?, record_hash = ?, ${entity === 'snapshot' ? 'created_at' : 'updated_at'} = ? WHERE id = ?`,
            args: [previousData, previousHash, parsed.updated_at ?? parsed.created_at ?? '', id],
          });
        }
        await transaction.execute({
          sql: 'DELETE FROM runtime_migration_items WHERE migration_id = ? AND entity = ? AND entity_id = ?',
          args: [migrationId, entity, id],
        });
      }
      if (report.rollback_conflicts!.length === 0) {
        await transaction.execute({ sql: 'DELETE FROM runtime_migration_items WHERE migration_id = ?', args: [migrationId] });
        await transaction.execute({ sql: 'DELETE FROM runtime_migrations WHERE migration_id = ?', args: [migrationId] });
      } else {
        await transaction.execute({
          sql: "UPDATE runtime_migrations SET status = 'rollback_partial' WHERE migration_id = ?",
          args: [migrationId],
        });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
    return report;
  } finally {
    client.close();
  }
}

export function newMigrationRunId(): string {
  return randomUUID();
}
