import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';

import { RepositorySnapshotSchema, type RepositorySnapshot } from '../domain/schemas.js';

const execFile = promisify(execFileCallback);
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ArchiveSnapshotInput = {
  snapshotRoot: string;
  repositoryId: string;
  repositoryName: string;
  requestedRef: string;
  expectedCommit: string;
  archive: Uint8Array;
};

export class ArchiveSnapshotError extends Error {
  public constructor(
    readonly code: 'invalid_input' | 'invalid_archive' | 'unsafe_archive' | 'snapshot_conflict',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ArchiveSnapshotError';
  }
}

/** Materialize a GitLab archive as an immutable, non-Git source snapshot. */
export async function materializeArchiveSnapshot(input: ArchiveSnapshotInput): Promise<RepositorySnapshot> {
  assertInput(input);
  const root = resolve(input.snapshotRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspace = resolve(root, input.repositoryId, input.expectedCommit);
  assertWithin(root, workspace);
  const metadataPath = join(workspace, '.harmony-agent-snapshot.json');
  const existing = await readExistingSnapshot(metadataPath);
  if (existing) {
    assertSnapshotIdentity(existing, input, workspace);
    return existing;
  }

  const temporaryRoot = await mkdtemp(join(root, '.archive-snapshot-'));
  const archivePath = join(temporaryRoot, 'source.tar.gz');
  const extractedRoot = join(temporaryRoot, 'workspace');
  try {
    await mkdir(extractedRoot, { recursive: true, mode: 0o700 });
    await writeFile(archivePath, input.archive, { mode: 0o600 });
    const entries = await listArchiveEntries(archivePath);
    const stripComponents = validateArchiveEntries(entries);
    await rejectArchiveLinks(archivePath);
    await extractArchive(archivePath, extractedRoot, stripComponents);
    await rejectSymlinks(extractedRoot);

    const snapshot = RepositorySnapshotSchema.parse({
      repository_id: input.repositoryId,
      repository_name: input.repositoryName,
      requested_ref: input.requestedRef,
      resolved_commit: input.expectedCommit,
      workspace_path: workspace,
      source: 'gitlab-api-archive',
    });
    const temporaryMetadata = join(extractedRoot, '.harmony-agent-snapshot.json');
    await writeFile(temporaryMetadata, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryMetadata, 0o600);
    await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
    if (await pathExists(workspace)) {
      throw new ArchiveSnapshotError('snapshot_conflict', '目标快照在物化过程中已被创建');
    }
    await rename(extractedRoot, workspace);
    return snapshot;
  } catch (error) {
    if (error instanceof ArchiveSnapshotError) throw error;
    throw new ArchiveSnapshotError('invalid_archive', '无法解包 GitLab archive', { cause: error });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function validateArchiveSnapshot(
  snapshot: RepositorySnapshot,
  snapshotRoot: string,
): Promise<RepositorySnapshot> {
  const parsed = RepositorySnapshotSchema.parse(snapshot);
  if (parsed.source !== 'gitlab-api-archive') {
    throw new ArchiveSnapshotError('invalid_input', '快照不是 GitLab archive 来源');
  }
  const workspace = resolve(snapshotRoot, parsed.repository_id, parsed.resolved_commit);
  assertWithin(resolve(snapshotRoot), workspace);
  if (resolve(parsed.workspace_path) !== workspace || !(await pathExists(workspace))) {
    throw new ArchiveSnapshotError('invalid_archive', '归档快照路径不存在或身份不一致');
  }
  const workspaceStat = await lstat(workspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new ArchiveSnapshotError('unsafe_archive', '归档快照根目录不是普通目录');
  }
  await rejectSymlinks(workspace);
  const metadata = await readExistingSnapshot(join(workspace, '.harmony-agent-snapshot.json'));
  if (!metadata) throw new ArchiveSnapshotError('invalid_archive', '归档快照缺少 metadata');
  if (JSON.stringify(metadata) !== JSON.stringify(parsed)) {
    throw new ArchiveSnapshotError('invalid_archive', '归档快照 metadata 与输入不一致');
  }
  return parsed;
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  try {
    const result = await execFile('tar', ['-tzf', archivePath], { maxBuffer: 32 * 1024 * 1024 });
    return result.stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    throw new ArchiveSnapshotError('invalid_archive', 'tar 列表读取失败', { cause: error });
  }
}

async function rejectArchiveLinks(archivePath: string): Promise<void> {
  try {
    const result = await execFile('tar', ['-tvzf', archivePath], { maxBuffer: 32 * 1024 * 1024 });
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const type = line[0];
      if (type === 'l' || type === 'h') {
        throw new ArchiveSnapshotError('unsafe_archive', 'archive 不允许包含符号链接或硬链接');
      }
    }
  } catch (error) {
    if (error instanceof ArchiveSnapshotError) throw error;
    throw new ArchiveSnapshotError('invalid_archive', 'archive 类型读取失败', { cause: error });
  }
}

function validateArchiveEntries(entries: readonly string[]): number {
  if (entries.length === 0) throw new ArchiveSnapshotError('invalid_archive', 'archive 不包含文件');
  const normalized = entries.map((entry) => {
    const value = entry.replaceAll('\\', '/');
    if (value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
      throw new ArchiveSnapshotError('unsafe_archive', `archive 包含绝对路径：${entry}`);
    }
    const parts = value.split('/').filter((part) => part && part !== '.');
    if (parts.some((part) => part === '..')) {
      throw new ArchiveSnapshotError('unsafe_archive', `archive 包含路径穿越：${entry}`);
    }
    return parts;
  });
  const first = normalized.find((parts) => parts.length > 0)?.[0];
  if (!first) throw new ArchiveSnapshotError('invalid_archive', 'archive 不包含有效路径');
  const hasSingleRoot = normalized.every((parts) => parts.length > 0 && parts[0] === first);
  return hasSingleRoot ? 1 : 0;
}

async function extractArchive(archivePath: string, target: string, stripComponents: number): Promise<void> {
  const args = ['-xzf', archivePath, '-C', target];
  if (stripComponents > 0) args.push('--strip-components=1');
  try {
    await execFile('tar', args, { maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new ArchiveSnapshotError('invalid_archive', 'tar 解包失败', { cause: error });
  }
}

async function rejectSymlinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new ArchiveSnapshotError('unsafe_archive', `archive 包含符号链接：${entry.name}`);
    if (entry.isDirectory()) await rejectSymlinks(path);
  }
}

async function readExistingSnapshot(path: string): Promise<RepositorySnapshot | null> {
  try {
    const parsed = RepositorySnapshotSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) throw new ArchiveSnapshotError('snapshot_conflict', '已有快照 metadata 无效');
    return parsed.data;
  } catch (error) {
    if (error instanceof ArchiveSnapshotError) throw error;
    return null;
  }
}

function assertInput(input: ArchiveSnapshotInput): void {
  if (!REPOSITORY_ID_PATTERN.test(input.repositoryId)) throw new ArchiveSnapshotError('invalid_input', 'repository id 无效');
  if (!input.repositoryName.trim() || !input.requestedRef.trim()) throw new ArchiveSnapshotError('invalid_input', '快照身份字段不能为空');
  if (!COMMIT_PATTERN.test(input.expectedCommit)) throw new ArchiveSnapshotError('invalid_input', 'expected commit 格式无效');
  if (input.archive.byteLength === 0) throw new ArchiveSnapshotError('invalid_archive', 'archive 为空');
}

function assertSnapshotIdentity(snapshot: RepositorySnapshot, input: ArchiveSnapshotInput, workspace: string): void {
  if (
    snapshot.source !== 'gitlab-api-archive' ||
    snapshot.repository_id !== input.repositoryId ||
    snapshot.repository_name !== input.repositoryName ||
    snapshot.requested_ref !== input.requestedRef ||
    snapshot.resolved_commit !== input.expectedCommit ||
    resolve(snapshot.workspace_path) !== workspace
  ) {
    throw new ArchiveSnapshotError('snapshot_conflict', '已有快照与目标 commit 身份不一致');
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function assertWithin(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
    throw new ArchiveSnapshotError('invalid_input', '快照路径超出配置根目录');
  }
}
