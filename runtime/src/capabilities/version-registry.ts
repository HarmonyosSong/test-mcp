import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  ClientFormFactorSchema,
  ClientPlatformSchema,
  ClientProductLineSchema,
} from '../domain/schemas.js';
import { normalizeClientVersion } from './repository.js';

export const ProductLineSchema = ClientProductLineSchema;
export const FormFactorSchema = ClientFormFactorSchema;
export const RegistryRepoRoleSchema = z.enum(['shell', 'component', 'config']);

const RegistryRepositorySchema = z.strictObject({
  repository_id: z.string().trim().min(1).max(300),
  role: RegistryRepoRoleSchema,
  // Shell is mounted at the composite root; component/config repositories use
  // a relative path under that root.
  mount_path: z.string().trim().max(500).optional().default(''),
  ref: z.string().trim().min(1).max(500),
  expected_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
});

const RegistryBuildSchema = z.strictObject({
  build: z.string().trim().min(1).max(100).nullable().optional(),
  tag: z.string().trim().min(1).max(500),
  repos: z.array(RegistryRepositorySchema).min(1),
  source: z.enum(['tag-scan', 'manual']),
  verified: z.boolean(),
}).superRefine((value, ctx) => {
  const shells = value.repos.filter((repository) => repository.role === 'shell');
  if (shells.length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['repos'], message: '每个构建必须且只能登记一个 shell 仓库' });
  }
  const mountPaths = new Set<string>();
  for (const [index, repository] of value.repos.entries()) {
    const mountPath = repository.mount_path;
    const segments = mountPath.split('/');
    const unsafe = mountPath !== '' && (
      mountPath.startsWith('/') ||
      mountPath.includes('\\') ||
      /^[A-Za-z]:/.test(mountPath) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    );
    if (unsafe) {
      ctx.addIssue({ code: 'custom', path: ['repos', index, 'mount_path'], message: 'mount_path 必须是安全的相对路径' });
    }
    if (repository.role === 'shell' && mountPath !== '') {
      ctx.addIssue({ code: 'custom', path: ['repos', index, 'mount_path'], message: 'shell 仓库的 mount_path 必须为空' });
    }
    if (repository.role !== 'shell' && mountPath === '') {
      ctx.addIssue({ code: 'custom', path: ['repos', index, 'mount_path'], message: 'component/config 仓库必须提供 mount_path' });
    }
    if (mountPaths.has(mountPath)) {
      ctx.addIssue({ code: 'custom', path: ['repos', index, 'mount_path'], message: 'mount_path 不能重复' });
    }
    mountPaths.add(mountPath);
  }
});

const RegistryFileEntrySchema = z.strictObject({
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/),
  form_factor: FormFactorSchema.optional().default('universal'),
  builds: z.array(RegistryBuildSchema).min(1),
});

export const VersionRegistryEntrySchema = RegistryFileEntrySchema.extend({
  platform: ClientPlatformSchema,
  product_line: ProductLineSchema,
});

export type ProductLine = z.infer<typeof ProductLineSchema>;
export type FormFactor = z.infer<typeof FormFactorSchema>;
// Public selection inputs remain compatible with pre-M4 hand-authored entries
// that omit mount_path; loaded entries always receive the schema default.
export type VersionRegistryRepository = z.input<typeof RegistryRepositorySchema>;
export type VersionRegistryBuild = z.input<typeof RegistryBuildSchema>;
export type VersionRegistryEntry = z.input<typeof VersionRegistryEntrySchema>;

export class VersionRegistryError extends Error {
  public constructor(
    readonly code: 'invalid_registry' | 'version_not_registered' | 'version_ambiguous' | 'build_required' | 'build_not_registered',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'VersionRegistryError';
  }
}

export type VersionSelectionInput = {
  platform: z.infer<typeof ClientPlatformSchema>;
  productLine: ProductLine;
  formFactor?: FormFactor;
  version?: string | null;
  build?: string | null;
};

export type VersionSelection = {
  entry: VersionRegistryEntry;
  build: VersionRegistryBuild;
  repositories: VersionRegistryRepository[];
};

export async function loadVersionRegistry(root: string): Promise<VersionRegistryEntry[]> {
  const entries: VersionRegistryEntry[] = [];
  let platformDirectories;
  try {
    platformDirectories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return entries;
    throw new VersionRegistryError('invalid_registry', `无法读取版本登记目录：${root}`, { cause: error });
  }

  for (const platformDirectory of platformDirectories) {
    if (!platformDirectory.isDirectory()) continue;
    const platform = ClientPlatformSchema.safeParse(platformDirectory.name);
    if (!platform.success) continue;
    let files;
    try {
      files = await readdir(join(root, platformDirectory.name), { withFileTypes: true });
    } catch (error) {
      throw new VersionRegistryError('invalid_registry', `无法读取平台登记目录：${platformDirectory.name}`, { cause: error });
    }
    for (const file of files) {
      if (!file.isFile() || !['.yaml', '.yml'].includes(extname(file.name).toLowerCase())) continue;
      const productLine = ProductLineSchema.safeParse(basename(file.name, extname(file.name)));
      if (!productLine.success) {
        throw new VersionRegistryError('invalid_registry', `登记文件名不是合法产品线：${file.name}`);
      }
      entries.push(...await loadVersionRegistryFile(
        join(root, platformDirectory.name, file.name),
        platform.data,
        productLine.data,
      ));
    }
  }
  return entries;
}

export async function loadVersionRegistryFile(
  path: string,
  platform: z.infer<typeof ClientPlatformSchema>,
  productLine: ProductLine,
): Promise<VersionRegistryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new VersionRegistryError('invalid_registry', `无法读取登记文件：${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = parseYaml(raw);
  } catch (error) {
    throw new VersionRegistryError('invalid_registry', `登记文件 YAML 无效：${path}`, { cause: error });
  }
  const parsed = z.array(RegistryFileEntrySchema).safeParse(value);
  if (!parsed.success) {
    throw new VersionRegistryError('invalid_registry', `登记文件结构无效：${path}`, { cause: parsed.error });
  }
  return parsed.data.map((entry) => ({ ...entry, platform, product_line: productLine }));
}

export function selectVersionRegistryEntry(
  entries: readonly VersionRegistryEntry[],
  input: VersionSelectionInput,
): VersionSelection {
  const requestedVersion = input.version?.trim() || null;
  if (requestedVersion && /^v?\d+\.\d+\.\d+\.\d+$/i.test(requestedVersion) && !input.build?.trim()) {
    throw new VersionRegistryError('build_required', `四段版本 ${input.version} 必须提供构建号或渠道信息`);
  }
  const formFactor = input.formFactor;
  const scopedEntries = entries.filter((entry) =>
    entry.platform === input.platform &&
    entry.product_line === input.productLine &&
    (formFactor === undefined || entry.form_factor === formFactor),
  );
  const version = requestedVersion ? normalizeClientVersion(requestedVersion) : null;
  const candidates = version
    ? scopedEntries.filter((entry) => normalizeClientVersion(entry.version) === version)
    : latestVersionEntries(scopedEntries);
  if (candidates.length === 0) {
    throw new VersionRegistryError(
      'version_not_registered',
      requestedVersion
        ? `没有登记 ${input.platform}/${input.productLine}/${requestedVersion}`
        : `没有 ${input.platform}/${input.productLine} 的已核验版本`,
    );
  }
  if (candidates.length !== 1) {
    throw new VersionRegistryError('version_ambiguous', `版本 ${input.version} 命中多个端或形态登记`);
  }

  const verifiedBuilds = candidates[0]!.builds.filter((build) => build.verified);
  if (verifiedBuilds.length === 0) {
    throw new VersionRegistryError('version_not_registered', `版本 ${input.version} 没有已核验构建`);
  }
  const requestedBuild = input.build?.trim() || null;
  let builds = requestedBuild
    ? verifiedBuilds.filter((build) => build.build === requestedBuild)
    : verifiedBuilds;
  if (builds.length === 0) {
    throw new VersionRegistryError('build_not_registered', `版本 ${input.version} 没有构建 ${requestedBuild}`);
  }
  if (builds.length > 1) {
    // Version-only requests intentionally bind the newest verified build. The
    // registry order is not authoritative, so use numeric build IDs first and
    // the tag as a deterministic fallback for iOS-style nonnumeric builds.
    builds = [selectLatestBuild(builds)];
  }
  return {
    entry: candidates[0]!,
    build: builds[0]!,
    repositories: builds[0]!.repos,
  };
}

function latestVersionEntries(entries: readonly VersionRegistryEntry[]): VersionRegistryEntry[] {
  const verifiedEntries = entries.filter((entry) => entry.builds.some((build) => build.verified));
  if (verifiedEntries.length === 0) return [];
  const latestVersion = verifiedEntries.reduce((latest, entry) =>
    compareVersions(entry.version, latest) > 0 ? entry.version : latest,
    verifiedEntries[0]!.version,
  );
  return verifiedEntries.filter((entry) => entry.version === latestVersion);
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeClientVersion(left).split('.').map(Number);
  const rightParts = normalizeClientVersion(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function selectLatestBuild<T extends { build?: string | null; tag: string }>(builds: readonly T[]): T {
  return [...builds].sort((left, right) => {
    const leftBuild = left.build?.trim() ?? '';
    const rightBuild = right.build?.trim() ?? '';
    const leftNumber = /^\d+$/.test(leftBuild) ? Number(leftBuild) : null;
    const rightNumber = /^\d+$/.test(rightBuild) ? Number(rightBuild) : null;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return rightNumber - leftNumber;
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    return right.tag.localeCompare(left.tag, 'en-US');
  })[0]!;
}

/** Runtime-owned registry; callers cannot mutate the loaded source of truth. */
export class VersionRegistry {
  private loadedEntries: VersionRegistryEntry[] = [];
  private loaded = false;

  public constructor(readonly root: string) {}

  public async load(): Promise<readonly VersionRegistryEntry[]> {
    this.loadedEntries = await loadVersionRegistry(this.root);
    this.loaded = true;
    return this.entries();
  }

  public entries(): readonly VersionRegistryEntry[] {
    return this.loadedEntries.map((entry) => ({
      ...entry,
      builds: entry.builds.map((build) => ({
        ...build,
        repos: build.repos.map((repository) => ({ ...repository })),
      })),
    }));
  }

  public select(input: VersionSelectionInput): VersionSelection {
    if (!this.loaded) throw new VersionRegistryError('invalid_registry', '版本登记表尚未加载');
    return selectVersionRegistryEntry(this.entries(), input);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
