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
  ref: z.string().trim().min(1).max(500),
  expected_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
});

const RegistryBuildSchema = z.strictObject({
  build: z.string().trim().min(1).max(100).nullable().optional(),
  tag: z.string().trim().min(1).max(500),
  repos: z.array(RegistryRepositorySchema).min(1),
  source: z.enum(['tag-scan', 'manual']),
  verified: z.boolean(),
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
export type VersionRegistryRepository = z.infer<typeof RegistryRepositorySchema>;
export type VersionRegistryBuild = z.infer<typeof RegistryBuildSchema>;
export type VersionRegistryEntry = z.infer<typeof VersionRegistryEntrySchema>;

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
  version: string;
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
  if (/^v?\d+\.\d+\.\d+\.\d+$/i.test(input.version.trim()) && !input.build?.trim()) {
    throw new VersionRegistryError('build_required', `四段版本 ${input.version} 必须提供构建号或渠道信息`);
  }
  const version = normalizeClientVersion(input.version);
  const formFactor = input.formFactor;
  const candidates = entries.filter((entry) =>
    entry.platform === input.platform &&
    entry.product_line === input.productLine &&
    normalizeClientVersion(entry.version) === version &&
    (formFactor === undefined || entry.form_factor === formFactor),
  );
  if (candidates.length === 0) {
    throw new VersionRegistryError(
      'version_not_registered',
      `没有登记 ${input.platform}/${input.productLine}/${input.version}`,
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
  const builds = requestedBuild
    ? verifiedBuilds.filter((build) => build.build === requestedBuild)
    : verifiedBuilds;
  if (builds.length === 0) {
    throw new VersionRegistryError('build_not_registered', `版本 ${input.version} 没有构建 ${requestedBuild}`);
  }
  if (builds.length !== 1) {
    throw new VersionRegistryError('version_ambiguous', `版本 ${input.version} 需要构建号才能唯一选择`);
  }
  return {
    entry: candidates[0]!,
    build: builds[0]!,
    repositories: builds[0]!.repos,
  };
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
