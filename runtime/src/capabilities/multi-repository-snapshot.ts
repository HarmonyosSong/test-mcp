import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { RepositorySnapshot } from '../domain/schemas.js';

export type CompositeRepositoryRole = 'shell' | 'component' | 'config';

export type CompositeRepositoryInput = {
  snapshot: RepositorySnapshot;
  role: CompositeRepositoryRole;
  mountPath: string;
};

export type CompositeRepositoryManifestEntry = {
  repository_id: string;
  repository_name: string;
  requested_ref: string;
  resolved_commit: string;
  role: CompositeRepositoryRole;
  mount_path: string;
};

export type CompositeRepositoryManifest = {
  source: 'multi-repository';
  workspace_path: string;
  repositories: CompositeRepositoryManifestEntry[];
  created_at: string;
};

export class MultiRepositorySnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MultiRepositorySnapshotError';
  }
}

const MANIFEST_NAME = '.harmony-agent-multi-snapshot.json';

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function validateMountPath(mountPath: string): string {
  const value = mountPath.trim();
  if (!value || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    throw new MultiRepositorySnapshotError(`invalid repository mount path: ${mountPath}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new MultiRepositorySnapshotError(`invalid repository mount path: ${mountPath}`);
  }
  return value;
}

function validateInputs(inputs: readonly CompositeRepositoryInput[]): CompositeRepositoryManifestEntry[] {
  const shells = inputs.filter((item) => item.role === 'shell');
  if (shells.length !== 1) throw new MultiRepositorySnapshotError('组合快照必须且只能有一个 shell 仓库');
  const mounts = new Set<string>();
  const entries = inputs.map((item) => {
    const mountPath = item.role === 'shell' ? '' : validateMountPath(item.mountPath);
    if (item.role === 'shell' && item.mountPath !== '') {
      throw new MultiRepositorySnapshotError('shell 仓库的 mount_path 必须为空');
    }
    if (mounts.has(mountPath)) throw new MultiRepositorySnapshotError(`重复的 repository mount path: ${mountPath}`);
    mounts.add(mountPath);
    return {
      repository_id: item.snapshot.repository_id,
      repository_name: item.snapshot.repository_name,
      requested_ref: item.snapshot.requested_ref,
      resolved_commit: item.snapshot.resolved_commit,
      role: item.role,
      mount_path: mountPath,
    } satisfies CompositeRepositoryManifestEntry;
  });
  return entries.sort((left, right) => left.mount_path.localeCompare(right.mount_path));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function copyTree(sourceRoot: string, destinationRoot: string, relativePath = ''): Promise<void> {
  const source = resolve(sourceRoot, relativePath);
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new MultiRepositorySnapshotError(`源码快照包含不允许的符号链接: ${relativePath || '.'}`);
  if (!sourceStat.isDirectory()) throw new MultiRepositorySnapshotError(`源码快照根目录不是目录: ${source}`);

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.harmony-agent-snapshot.json') continue;
    const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
    const sourceChild = resolve(sourceRoot, childRelative);
    const destinationChild = resolve(destinationRoot, childRelative);
    if (!isWithin(resolve(sourceRoot), sourceChild) || !isWithin(resolve(destinationRoot), destinationChild)) {
      throw new MultiRepositorySnapshotError(`源码快照路径越界: ${childRelative}`);
    }
    if (entry.isSymbolicLink()) {
      throw new MultiRepositorySnapshotError(`源码快照包含不允许的符号链接: ${childRelative}`);
    }
    if (entry.isDirectory()) {
      await mkdir(destinationChild, { recursive: true, mode: 0o700 });
      await copyTree(sourceRoot, destinationRoot, childRelative);
      continue;
    }
    if (!entry.isFile()) throw new MultiRepositorySnapshotError(`源码快照包含不支持的文件类型: ${childRelative}`);
    if (await pathExists(destinationChild)) {
      throw new MultiRepositorySnapshotError(`组合快照存在文件冲突: ${childRelative}`);
    }
    await mkdir(dirname(destinationChild), { recursive: true, mode: 0o700 });
    await copyFile(sourceChild, destinationChild);
  }
}

async function readManifest(path: string): Promise<CompositeRepositoryManifest> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as CompositeRepositoryManifest;
    if (value.source !== 'multi-repository' || typeof value.workspace_path !== 'string' || !Array.isArray(value.repositories)) {
      throw new Error('invalid composite manifest');
    }
    return value;
  } catch (error) {
    throw new MultiRepositorySnapshotError(`组合快照 manifest 无效: ${path}`, { cause: error });
  }
}

async function reuseExisting(
  workspace: string,
  expectedEntries: readonly CompositeRepositoryManifestEntry[],
): Promise<CompositeRepositoryManifest | null> {
  if (!(await pathExists(workspace))) return null;
  const manifestPath = join(workspace, MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  if (resolve(manifest.workspace_path) !== workspace || stableJson(manifest.repositories) !== stableJson(expectedEntries)) {
    throw new MultiRepositorySnapshotError(`组合快照已存在但身份不匹配: ${workspace}`);
  }
  return manifest;
}

/** Materialize a read-only composite workspace from already verified snapshots. */
export async function materializeMultiRepositorySnapshot(options: {
  snapshotRoot: string;
  repositories: readonly CompositeRepositoryInput[];
}): Promise<CompositeRepositoryManifest> {
  const entries = validateInputs(options.repositories);
  const key = createHash('sha256').update(stableJson(entries)).digest('hex').slice(0, 32);
  const root = resolve(options.snapshotRoot, 'multi');
  const workspace = resolve(root, key);
  if (!isWithin(root, workspace)) throw new MultiRepositorySnapshotError('组合快照路径越界');
  const existing = await reuseExisting(workspace, entries);
  if (existing) return existing;

  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, `.tmp-${key}-`));
  const manifest: CompositeRepositoryManifest = {
    source: 'multi-repository',
    workspace_path: workspace,
    repositories: entries,
    created_at: new Date().toISOString(),
  };
  try {
    const shell = options.repositories.find((item) => item.role === 'shell')!;
    await copyTree(shell.snapshot.workspace_path, stage);
    for (const item of options.repositories) {
      if (item.role === 'shell') continue;
      const mountPath = validateMountPath(item.mountPath);
      const mountRoot = resolve(stage, mountPath);
      if (!isWithin(stage, mountRoot)) throw new MultiRepositorySnapshotError(`组合挂载路径越界: ${mountPath}`);
      await mkdir(mountRoot, { recursive: true, mode: 0o700 });
      await copyTree(item.snapshot.workspace_path, mountRoot);
    }
    await writeFile(join(stage, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(stage, workspace);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      await rm(stage, { recursive: true, force: true });
      const raced = await reuseExisting(workspace, entries);
      if (!raced) throw new MultiRepositorySnapshotError(`组合快照并发创建失败: ${workspace}`);
      return raced;
    }
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (error instanceof MultiRepositorySnapshotError) throw error;
    throw new MultiRepositorySnapshotError('组合快照物化失败', { cause: error });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
