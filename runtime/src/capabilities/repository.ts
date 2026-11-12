import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  RepositoryRecordSchema,
  RepositorySnapshotSchema,
  type RepositoryRecord,
  type RepositorySnapshot,
} from '../domain/schemas.js';
import { materializeArchiveSnapshot, validateArchiveSnapshot } from './archive-snapshot.js';

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const SCP_URL_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/;

export interface RepositoryCapabilityOptions {
  snapshotDir: string;
  initialRecords?: readonly RepositoryRecord[];
}

export interface RegistryRepositoryOptions {
  baseUrl: string;
  ref: string;
  persist?: (record: RepositoryRecord) => Promise<unknown>;
}

export class RepositoryNotFoundError extends Error {
  constructor(repositoryId: string) {
    super(`repository not found: ${repositoryId}`);
    this.name = 'RepositoryNotFoundError';
  }
}

export class RepositoryGitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RepositoryGitError';
  }
}

export class SnapshotNotReadyError extends RepositoryGitError {
  readonly code = 'snapshot_not_ready';

  constructor(message: string, options?: { cause?: unknown }) {
    super(`snapshot_not_ready: ${message}`, options);
    this.name = 'SnapshotNotReadyError';
  }
}

function cloneRecord(record: RepositoryRecord): RepositoryRecord {
  return RepositoryRecordSchema.parse({ ...record });
}

function normalizeRemoteRepositoryId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const scp = SCP_URL_PATTERN.exec(trimmed);
  if (scp) return trimmed.slice(trimmed.indexOf(':') + 1).replace(/\.git$/, '');
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return '';
    return decodeURIComponent(parsed.pathname).replace(/^\/+/, '').replace(/\.git$/, '');
  } catch {
    return trimmed.replace(/^\/+/, '').replace(/\.git$/, '');
  }
}

function registryRecordId(remoteRepositoryId: string): string {
  return `registry-${createHash('sha256').update(remoteRepositoryId).digest('hex').slice(0, 20)}`;
}

function registryRepositoryUrl(baseUrl: string, remoteRepositoryId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new RepositoryGitError('registry GitLab base URL is invalid', { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RepositoryGitError('registry GitLab base URL must use HTTP(S)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new RepositoryGitError('registry GitLab base URL must be an origin without credentials');
  }
  return new URL(`${remoteRepositoryId.replace(/^\/+/, '').replace(/\/+$/, '')}.git`, parsed).toString();
}

/**
 * Source selection is owned by version-registry. This capability only materializes
 * and validates the immutable archive selected by that registry.
 */
export class RepositoryCapability {
  private readonly snapshotDir: string;
  private readonly records = new Map<string, RepositoryRecord>();
  private readonly repositoryLocks = new Map<string, Promise<void>>();

  constructor(options: RepositoryCapabilityOptions) {
    this.snapshotDir = resolve(options.snapshotDir);
    for (const record of options.initialRecords ?? []) {
      const parsed = RepositoryRecordSchema.parse(record);
      this.records.set(parsed.id, cloneRecord(parsed));
    }
  }

  async get(repositoryId: string): Promise<RepositoryRecord> {
    const record = this.records.get(repositoryId);
    if (!record) throw new RepositoryNotFoundError(repositoryId);
    return cloneRecord(record);
  }

  /**
   * Create the internal record for a registry path on demand. Existing records
   * are addressed by the deterministic registry id, never by a user-selected
   * URL, branch, or default repository.
   */
  async ensureRegistryRepository(
    remoteRepositoryId: string,
    options: RegistryRepositoryOptions,
  ): Promise<RepositoryRecord> {
    const identifier = normalizeRemoteRepositoryId(remoteRepositoryId);
    if (!identifier) throw new RepositoryGitError('registry repository identifier is invalid');
    const id = registryRecordId(identifier);
    const url = registryRepositoryUrl(options.baseUrl, identifier);
    const previous = this.records.get(id);
    const record = RepositoryRecordSchema.parse({
      ...(previous ? { created_at: previous.created_at } : {}),
      id,
      name: identifier,
      url,
      // Retained for storage compatibility; the registry ref is the only
      // source-selection input used by the active runtime.
      default_branch: options.ref.trim(),
      ...(previous ? { updated_at: previous.updated_at } : {}),
    });
    const changed = !previous || previous.url !== record.url || previous.default_branch !== record.default_branch;
    if (!changed) return cloneRecord(previous);

    const persisted = previous
      ? RepositoryRecordSchema.parse({ ...record, updated_at: new Date().toISOString() })
      : record;
    try {
      await options.persist?.(persisted);
    } catch (error) {
      if (!previous) this.records.delete(id);
      throw error;
    }
    this.records.set(id, persisted);
    return cloneRecord(persisted);
  }

  async prepareArchiveSnapshot(
    repositoryId: string,
    requestedRef: string,
    expectedCommit: string,
    archive: Uint8Array,
  ): Promise<RepositorySnapshot> {
    const record = await this.get(repositoryId);
    return this.withRepositoryLock(repositoryId, () => materializeArchiveSnapshot({
      snapshotRoot: this.snapshotDir,
      repositoryId: record.id,
      repositoryName: record.name,
      requestedRef,
      expectedCommit,
      archive,
    }));
  }

  /** Only reuse an archive snapshot that exactly matches the registry mapping. */
  async getPreparedSnapshot(
    repositoryId: string,
    requestedRef: string,
    expectedCommit: string,
  ): Promise<RepositorySnapshot> {
    const record = await this.get(repositoryId);
    if (!requestedRef.trim()) throw new SnapshotNotReadyError('登记 ref 为空');
    if (!COMMIT_PATTERN.test(expectedCommit)) {
      throw new SnapshotNotReadyError('expected commit 格式无效');
    }
    const workspace = resolve(this.snapshotDir, record.id, expectedCommit);
    this.assertWithin(this.snapshotDir, workspace, 'snapshot path');
    const metadataPath = resolve(workspace, '.harmony-agent-snapshot.json');
    if (!(await this.pathExists(workspace)) || !(await this.pathExists(metadataPath))) {
      throw new SnapshotNotReadyError(`${record.id}@${expectedCommit} 尚未准备本地快照`);
    }
    try {
      const stored = await this.readSnapshotMetadata(metadataPath);
      if (stored.requested_ref !== requestedRef || stored.resolved_commit !== expectedCommit) {
        throw new SnapshotNotReadyError('本地快照的登记 ref 或 commit 不一致');
      }
      return await this.validateSnapshot(stored);
    } catch (error) {
      if (error instanceof SnapshotNotReadyError) throw error;
      throw new SnapshotNotReadyError(`${record.id}@${expectedCommit} 本地快照校验失败`, { cause: error });
    }
  }

  async validateSnapshot(snapshot: RepositorySnapshot): Promise<RepositorySnapshot> {
    const parsed = RepositorySnapshotSchema.parse(snapshot);
    if (!COMMIT_PATTERN.test(parsed.resolved_commit)) {
      throw new RepositoryGitError('snapshot has an invalid commit identifier');
    }
    if (parsed.source !== 'gitlab-api-archive') {
      throw new SnapshotNotReadyError('仅支持版本登记表生成的 GitLab archive 快照');
    }
    return validateArchiveSnapshot(parsed, this.snapshotDir);
  }

  async verifySnapshot(snapshot: RepositorySnapshot): Promise<RepositorySnapshot> {
    return this.validateSnapshot(snapshot);
  }

  private async readSnapshotMetadata(path: string): Promise<RepositorySnapshot> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const parsed = RepositorySnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new Error(parsed.error.message);
      return parsed.data;
    } catch (error) {
      throw new RepositoryGitError('invalid snapshot metadata', { cause: error });
    }
  }

  private assertWithin(root: string, candidate: string, label: string): void {
    const normalizedRoot = resolve(root);
    const normalizedCandidate = resolve(candidate);
    if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
      throw new RepositoryGitError(`${label} escapes its configured root`);
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  private async withRepositoryLock<T>(repositoryId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.repositoryLocks.get(repositoryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    this.repositoryLocks.set(repositoryId, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.repositoryLocks.get(repositoryId) === current) this.repositoryLocks.delete(repositoryId);
    }
  }
}

export { RepositoryCapability as RepositoryManager };
