import { execFile as execFileCallback } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  RepositoryRecordSchema,
  RepositorySnapshotSchema,
  type RepositoryRecord,
  type RepositorySnapshot,
} from '../domain/schemas.js';

const execFile = promisify(execFileCallback);
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const SCP_URL_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GIT_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR',
  'TMPDIR', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK',
] as const;

type GitResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export interface RegisterRepositoryRequest {
  name: string;
  url: string;
  default_branch?: string | null;
}

export interface RepositoryBranch {
  name: string;
  commit: string;
}

export interface RepositoryCapabilityOptions {
  mirrorDir: string;
  snapshotDir: string;
  allowedRoots?: readonly string[];
  timeoutMs?: number;
  initialRecords?: readonly RepositoryRecord[];
}

export class RepositoryNotFoundError extends Error {
  constructor(repositoryId: string) {
    super(`repository not found: ${repositoryId}`);
    this.name = 'RepositoryNotFoundError';
  }
}

export class RepositoryAlreadyExistsError extends Error {
  constructor(message = 'repository name or URL already registered') {
    super(message);
    this.name = 'RepositoryAlreadyExistsError';
  }
}

export class RepositoryGitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RepositoryGitError';
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function compareCaseInsensitive(left: string, right: string): number {
  const a = left.toLocaleLowerCase('en-US');
  const b = right.toLocaleLowerCase('en-US');
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneRecord(record: RepositoryRecord): RepositoryRecord {
  return RepositoryRecordSchema.parse({ ...record });
}

function cloneSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  return RepositorySnapshotSchema.parse({ ...snapshot });
}

function formatGitError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { stderr?: unknown; message?: unknown };
    if (typeof candidate.stderr === 'string' && candidate.stderr.trim()) {
      return candidate.stderr.trim();
    }
    if (typeof candidate.message === 'string' && candidate.message.includes('ETIMEDOUT')) return 'git operation timed out';
  }
  return 'git operation failed';
}

function parseRepositoryRequest(request: RegisterRepositoryRequest): {
  name: string;
  url: string;
  defaultBranch: string | null;
} {
  const name = request.name.trim();
  const url = request.url.trim();
  const defaultBranch = request.default_branch?.trim() || null;
  if (name.length < 2 || name.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new RepositoryGitError('repository name is invalid');
  }
  if (url.length < 8 || url.length > 2_000) {
    throw new RepositoryGitError('repository URL is invalid');
  }
  if (defaultBranch !== null && defaultBranch.length > 500) {
    throw new RepositoryGitError('default branch is invalid');
  }
  let normalizedUrl = url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') normalizedUrl = pathToFileURL(fileURLToPath(parsed)).href;
  } catch {
    // Non-URL Git forms such as SCP syntax are validated separately.
  }
  return { name, url: normalizedUrl, defaultBranch };
}

/**
 * Validate URL syntax before any network or Git operation is attempted.
 * This intentionally follows the product's supported HTTP(S), SSH, file and
 * SCP forms rather than allowing Git to interpret arbitrary command syntax.
 */
export function validateRepositoryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    if (SCP_URL_PATTERN.test(url)) return;
    throw new RepositoryGitError('repository URL must use HTTP(S), SSH, or SCP syntax');
  }

  if (parsed.protocol === 'file:') {
    if (!parsed.pathname || parsed.hostname) {
      throw new RepositoryGitError('local repository URL must contain a local path');
    }
    return;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (!parsed.hostname || parsed.username || parsed.password || /[?#]/.test(url)) {
      throw new RepositoryGitError('repository URL must include a host and must not contain credentials');
    }
    return;
  }
  if (parsed.protocol === 'ssh:') {
    if (!parsed.hostname || parsed.password || /[?#]/.test(url)) {
      throw new RepositoryGitError('repository URL must include a host and must not contain credentials');
    }
    return;
  }
  throw new RepositoryGitError('repository URL must use HTTP(S), SSH, or SCP syntax');
}

export class RepositoryCapability {
  private readonly mirrorDir: string;
  private readonly snapshotDir: string;
  private readonly allowedRoots: readonly string[];
  private readonly timeoutMs: number;
  private readonly records = new Map<string, RepositoryRecord>();
  private readonly repositoryLocks = new Map<string, Promise<void>>();

  constructor(options: RepositoryCapabilityOptions) {
    this.mirrorDir = resolve(options.mirrorDir);
    this.snapshotDir = resolve(options.snapshotDir);
    this.allowedRoots = (options.allowedRoots?.length ? options.allowedRoots : [process.cwd()])
      .map((root) => resolve(root));
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RepositoryGitError('git timeout must be a positive integer');
    }
    for (const record of options.initialRecords ?? []) {
      const parsed = RepositoryRecordSchema.parse(record);
      this.records.set(parsed.id, cloneRecord(parsed));
    }
  }

  async list(): Promise<RepositoryRecord[]> {
    return [...this.records.values()]
      .sort((left, right) => compareCaseInsensitive(left.name, right.name))
      .map(cloneRecord);
  }

  async get(repositoryId: string): Promise<RepositoryRecord> {
    const record = this.records.get(repositoryId);
    if (!record) throw new RepositoryNotFoundError(repositoryId);
    return cloneRecord(record);
  }

  async validateWorkspacePath(path: string): Promise<string> {
    let candidate: string;
    try {
      candidate = await realpath(resolve(path));
    } catch (error) {
      throw new RepositoryGitError('workspace path does not exist', { cause: error });
    }
    if (!(await stat(candidate)).isDirectory()) throw new RepositoryGitError('workspace path is not a directory');
    const roots: string[] = [];
    for (const root of this.allowedRoots) {
      try { roots.push(await realpath(root)); }
      catch (error) { throw new RepositoryGitError(`allowed root does not exist: ${root}`, { cause: error }); }
    }
    if (!roots.some((root) => isWithin(root, candidate))) throw new RepositoryGitError('workspace path is outside allowed roots');
    return candidate;
  }

  async register(request: RegisterRepositoryRequest): Promise<RepositoryRecord> {
    const parsed = parseRepositoryRequest(request);
    validateRepositoryUrl(parsed.url);
    await this.validateLocalRepositoryUrl(parsed.url);

    const defaultBranch = parsed.defaultBranch ?? await this.remoteDefaultBranch(parsed.url);
    await this.validateBranch(defaultBranch);
    const branches = await this.remoteBranches(parsed.url, defaultBranch);
    if (!branches.some((branch) => branch.name === defaultBranch)) {
      throw new RepositoryGitError(`remote branch not found: ${defaultBranch}`);
    }

    for (const existing of this.records.values()) {
      if (existing.name.toLocaleLowerCase('en-US') === parsed.name.toLocaleLowerCase('en-US') || existing.url === parsed.url) {
        throw new RepositoryAlreadyExistsError();
      }
    }
    const record = RepositoryRecordSchema.parse({
      name: parsed.name,
      url: parsed.url,
      default_branch: defaultBranch,
    });
    this.records.set(record.id, record);
    return cloneRecord(record);
  }

  async listBranches(
    repositoryId: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<RepositoryBranch[]> {
    const record = await this.get(repositoryId);
    const query = options.query?.trim().toLocaleLowerCase('en-US') ?? '';
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const branches = await this.remoteBranches(record.url);
    return branches
      .filter((branch) => !query || branch.name.toLocaleLowerCase('en-US').includes(query))
      .slice(0, limit);
  }

  async prepareSnapshot(repositoryId: string, branch: string): Promise<RepositorySnapshot> {
    const record = await this.get(repositoryId);
    return this.withRepositoryLock(repositoryId, async () => {
      await this.validateBranch(branch);
      const mirror = await this.ensureMirror(record);
      const remoteRef = `refs/remotes/origin/${branch}`;
      await this.git(
        '--git-dir',
        mirror,
        'fetch',
        '--no-tags',
        'origin',
      );
      await this.git(
        '--git-dir',
        mirror,
        'fetch',
        '--no-tags',
        '--depth=1',
        'origin',
        `+refs/heads/${branch}:${remoteRef}`,
      );
      const commit = (await this.git('--git-dir', mirror, 'rev-parse', `${remoteRef}^{commit}`)).stdout.trim();
      if (!COMMIT_PATTERN.test(commit)) {
        throw new RepositoryGitError('git returned an invalid commit identifier');
      }

      const workspace = resolve(this.snapshotDir, record.id, commit);
      this.assertWithin(this.snapshotDir, workspace, 'snapshot path');
      const metadataPath = resolve(workspace, '.harmony-agent-snapshot.json');
      let workspaceExists = false;
      try {
        const workspaceStat = await lstat(workspace);
        if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
          throw new RepositoryGitError('snapshot path exists without valid metadata');
        }
        workspaceExists = true;
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
      }

      if (workspaceExists) {
        if (!(await this.pathExists(metadataPath))) {
          throw new RepositoryGitError('snapshot path exists without valid metadata');
        }
        const snapshot = await this.readSnapshotMetadata(metadataPath);
        await this.assertSnapshotIdentity(snapshot, record, commit, workspace, mirror);
        return cloneSnapshot(snapshot);
      }

      await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
      try {
        await this.git('--git-dir', mirror, 'worktree', 'add', '--detach', workspace, commit);
        const snapshot = RepositorySnapshotSchema.parse({
          repository_id: record.id,
          repository_name: record.name,
          requested_ref: branch,
          resolved_commit: commit,
          workspace_path: workspace,
        });
        await this.assertSnapshotIdentity(snapshot, record, commit, workspace, mirror);
        await this.writeSnapshotMetadata(metadataPath, snapshot);
        return cloneSnapshot(snapshot);
      } catch (error) {
        if (await this.pathExists(workspace) && isWithin(this.snapshotDir, workspace)) {
          await rm(workspace, { recursive: true, force: true });
        }
        await this.git('--git-dir', mirror, 'worktree', 'prune', { check: false });
        throw error;
      }
    });
  }

  async validateSnapshot(snapshot: RepositorySnapshot): Promise<RepositorySnapshot> {
    const record = await this.get(snapshot.repository_id);
    const parsed = RepositorySnapshotSchema.parse(snapshot);
    const commit = parsed.resolved_commit;
    if (!COMMIT_PATTERN.test(commit)) {
      throw new RepositoryGitError('snapshot has an invalid commit identifier');
    }
    const mirror = await this.ensureMirror(record);
    const workspace = resolve(this.snapshotDir, record.id, commit);
    const metadataPath = resolve(workspace, '.harmony-agent-snapshot.json');
    const stored = await this.readSnapshotMetadata(metadataPath);
    if (
      stored.repository_id !== parsed.repository_id ||
      stored.repository_name !== parsed.repository_name ||
      stored.requested_ref !== parsed.requested_ref ||
      stored.resolved_commit !== parsed.resolved_commit ||
      resolve(stored.workspace_path) !== resolve(parsed.workspace_path) ||
      stored.created_at !== parsed.created_at
    ) {
      throw new RepositoryGitError('snapshot metadata identity does not match the supplied snapshot');
    }
    await this.assertSnapshotIdentity(stored, record, commit, workspace, mirror);
    return cloneSnapshot(parsed);
  }

  async verifySnapshot(snapshot: RepositorySnapshot): Promise<RepositorySnapshot> {
    return this.validateSnapshot(snapshot);
  }

  private async validateLocalRepositoryUrl(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return;
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(fileURLToPath(parsed));
    } catch (error) {
      throw new RepositoryGitError('local repository path does not exist', { cause: error });
    }
    const repositoryStat = await stat(repositoryPath);
    if (!repositoryStat.isDirectory()) {
      throw new RepositoryGitError('local repository path is not a directory');
    }
    const roots: string[] = [];
    for (const root of this.allowedRoots) {
      try {
        roots.push(await realpath(root));
      } catch (error) {
        throw new RepositoryGitError(`allowed root does not exist: ${root}`, { cause: error });
      }
    }
    if (!roots.some((root) => isWithin(root, repositoryPath))) {
      throw new RepositoryGitError('local repository is outside allowed roots');
    }
  }

  private async remoteDefaultBranch(url: string): Promise<string> {
    const output = await this.git('ls-remote', '--symref', url, 'HEAD');
    for (const line of output.stdout.split(/\r?\n/)) {
      if (line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD')) {
        return line.slice('ref: refs/heads/'.length, -'\tHEAD'.length);
      }
    }
    throw new RepositoryGitError('remote did not advertise a default branch');
  }

  private async remoteBranches(url: string, branch?: string): Promise<RepositoryBranch[]> {
    const args = ['ls-remote', '--heads', url];
    if (branch) args.push(`refs/heads/${branch}`);
    const output = await this.git(...args);
    const branches: RepositoryBranch[] = [];
    for (const line of output.stdout.split(/\r?\n/)) {
      const [commit, ref] = line.split('\t');
      if (!commit || !ref?.startsWith('refs/heads/') || !COMMIT_PATTERN.test(commit)) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit });
    }
    return branches.sort((left, right) => compareCaseInsensitive(left.name, right.name));
  }

  private async validateBranch(branch: string): Promise<void> {
    if (!branch || branch.startsWith('-') || [...branch].some((character) => character.charCodeAt(0) < 32)) {
      throw new RepositoryGitError('invalid branch name');
    }
    try {
      await this.git('check-ref-format', `refs/heads/${branch}`);
    } catch (error) {
      throw new RepositoryGitError('invalid branch name', { cause: error });
    }
  }

  private async ensureMirror(record: RepositoryRecord): Promise<string> {
    if (!REPOSITORY_ID_PATTERN.test(record.id)) {
      throw new RepositoryGitError('repository identifier is invalid');
    }
    await mkdir(this.mirrorDir, { recursive: true, mode: 0o700 });
    const mirror = resolve(this.mirrorDir, `${record.id}.git`);
    this.assertWithin(this.mirrorDir, mirror, 'mirror path');
    if (!(await this.pathExists(mirror))) {
      await this.git('init', '--bare', mirror);
      await this.git('--git-dir', mirror, 'remote', 'add', 'origin', record.url);
      return mirror;
    }
    try {
      const mirrorStat = await stat(mirror);
      if (!mirrorStat.isDirectory()) throw new Error('mirror is not a directory');
      const bare = (await this.git('--git-dir', mirror, 'rev-parse', '--is-bare-repository')).stdout.trim();
      if (bare !== 'true') throw new Error('mirror is not bare');
      const remote = (await this.git('--git-dir', mirror, 'remote', 'get-url', 'origin')).stdout.trim();
      if (remote !== record.url) throw new Error('mirror origin does not match repository URL');
    } catch (error) {
      throw new RepositoryGitError(`invalid repository mirror: ${formatGitError(error)}`, { cause: error });
    }
    return mirror;
  }

  private async readSnapshotMetadata(path: string): Promise<RepositorySnapshot> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const parsed = RepositorySnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new Error(parsed.error.message);
      return parsed.data;
    } catch (error) {
      throw new RepositoryGitError(`invalid snapshot metadata: ${formatGitError(error)}`, { cause: error });
    }
  }

  private async writeSnapshotMetadata(path: string, snapshot: RepositorySnapshot): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  private async assertSnapshotIdentity(
    snapshot: RepositorySnapshot,
    record: RepositoryRecord,
    expectedCommit: string,
    workspace: string,
    mirror: string,
  ): Promise<void> {
    if (snapshot.repository_id !== record.id || snapshot.repository_name !== record.name) {
      throw new RepositoryGitError('snapshot metadata identity does not match registry');
    }
    if (snapshot.resolved_commit !== expectedCommit) {
      throw new RepositoryGitError('snapshot metadata commit does not match requested remote commit');
    }
    const expectedWorkspace = resolve(this.snapshotDir, record.id, expectedCommit);
    if (resolve(snapshot.workspace_path) !== expectedWorkspace || workspace !== expectedWorkspace) {
      throw new RepositoryGitError('snapshot metadata path does not match its repository and commit');
    }
    this.assertWithin(this.snapshotDir, workspace, 'snapshot path');
    const snapshotRoot = await realpath(this.snapshotDir);
    const actualWorkspace = await realpath(workspace);
    const expectedRealWorkspace = await realpath(expectedWorkspace);
    const workspaceStat = await lstat(workspace);
    if (
      workspaceStat.isSymbolicLink() ||
      !workspaceStat.isDirectory() ||
      actualWorkspace !== expectedRealWorkspace ||
      !isWithin(snapshotRoot, actualWorkspace)
    ) {
      throw new RepositoryGitError('snapshot path escapes the configured snapshot root');
    }
    const head = (await this.git('-C', workspace, 'rev-parse', '--verify', 'HEAD^{commit}')).stdout.trim();
    if (head !== expectedCommit) throw new RepositoryGitError('snapshot HEAD does not match metadata commit');
    const symbolicHead = await this.git('-C', workspace, 'symbolic-ref', '--quiet', 'HEAD', { check: false });
    if (symbolicHead.code === 0) throw new RepositoryGitError('snapshot HEAD is attached to a branch');
    const commonDir = (await this.git('-C', workspace, 'rev-parse', '--git-common-dir')).stdout.trim();
    const actualMirror = await realpath(resolve(workspace, commonDir));
    const expectedMirror = await realpath(mirror);
    if (actualMirror !== expectedMirror) throw new RepositoryGitError('snapshot Git directory does not match mirror');
  }

  private async git(...args: [...string[], { check?: boolean }]): Promise<GitResult>;
  private async git(...args: string[]): Promise<GitResult>;
  private async git(...rawArgs: Array<string | { check?: boolean }>): Promise<GitResult> {
    const last = rawArgs.at(-1);
    const options = typeof last === 'object' ? last : {};
    const args = (typeof last === 'object' ? rawArgs.slice(0, -1) : rawArgs) as string[];
    try {
      const result = await execFile('git', args, {
        env: {
          ...Object.fromEntries(GIT_ENVIRONMENT_KEYS.flatMap((key) => {
            const value = process.env[key];
            return value === undefined ? [] : [[key, value]];
          })),
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: this.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
    } catch (error) {
      const candidate = error as { code?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown };
      const timedOut = candidate.code === 'ETIMEDOUT' || candidate.killed === true;
      if (options.check !== false) {
        if (timedOut) throw new RepositoryGitError('git operation timed out', { cause: error });
        throw new RepositoryGitError(formatGitError(error), { cause: error });
      }
      return {
        stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
        stderr: typeof candidate.stderr === 'string' ? candidate.stderr : '',
        code: typeof candidate.code === 'number' ? candidate.code : 1,
      };
    }
  }

  private assertWithin(root: string, candidate: string, label: string): void {
    if (!isWithin(root, candidate)) throw new RepositoryGitError(`${label} escapes its configured root`);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (this.isNotFound(error)) return false;
      throw error;
    }
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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
