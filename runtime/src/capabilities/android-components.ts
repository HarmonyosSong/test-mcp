import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { GitLabArchiveClient } from './gitlab-archive.js';
import type { VersionRegistryRepository } from './version-registry.js';

const REPO_DIR = /^[A-Za-z0-9_.-]{1,100}$/;
const REPOSITORY_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/;
// 钉版本为三到五段数字，可带 -SNAPSHOT 后缀（如 7.106.1.1-SNAPSHOT、7.106.0.5.2-SNAPSHOT）。
const PINNED_VERSION = /^\d+(?:\.\d+){2,4}(?:-SNAPSHOT)?$/;

const RulesSchema = z.object({
  repo_map: z.record(z.string().regex(REPO_DIR), z.string().regex(REPOSITORY_ID)),
  max_components: z.number().int().min(1).max(200).optional(),
});
export type AndroidComponentRules = z.infer<typeof RulesSchema>;

export async function loadAndroidComponentRules(path: string): Promise<AndroidComponentRules> {
  return RulesSchema.parse(parseYaml(await readFile(path, 'utf8')));
}

/** 从 settings.gradle 提取本地组件声明（只读文本，绝不执行 Groovy）。
 *  支持两种写法：
 *  - 字面量：setProjectDir(new File('../<仓库目录>/<模块>'))
 *  - 变量：setProjectDir(new File(<var>, '<模块>'))，其中 <var> 经 def 链最终落到 "../<仓库目录>" 默认值
 */
export function parseSettingsGradleModules(text: string): Array<{ repoDir: string; module: string }> {
  // 变量定义按声明顺序解析：def a = ...getProperty("KEY", "../repo") 或 def b = new File(a)...
  const variableRepoDir = new Map<string, string>();
  const defPattern = /^\s*def\s+(\w+)\s*=\s*(.+)$/gm;
  for (const match of text.matchAll(defPattern)) {
    const [, name, rhs] = match;
    const literal = /\.\.\/([A-Za-z0-9_.-]+)/.exec(rhs!);
    if (literal) { variableRepoDir.set(name!, literal[1]!); continue; }
    // 右值里引用到的任一已解析变量（如 new File(cloudlearningRootProp)）都传递仓库目录
    const inherited = [...rhs!.matchAll(/\b(\w+)\b/g)].map((ref) => variableRepoDir.get(ref[1]!)).find(Boolean);
    if (inherited) variableRepoDir.set(name!, inherited);
  }
  const found = new Map<string, { repoDir: string; module: string }>();
  const literalPattern = /setProjectDir\(\s*new File\(\s*['"]\.\.\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)['"]/g;
  for (const match of text.matchAll(literalPattern)) {
    found.set(`${match[1]}/${match[2]}`, { repoDir: match[1]!, module: match[2]! });
  }
  const variablePattern = /setProjectDir\(\s*new File\(\s*(\w+)\s*,\s*['"]([A-Za-z0-9_.-]+)['"]/g;
  for (const match of text.matchAll(variablePattern)) {
    const repoDir = variableRepoDir.get(match[1]!);
    if (repoDir) found.set(`${repoDir}/${match[2]}`, { repoDir, module: match[2]! });
  }
  return [...found.values()];
}

/** 从 gradle.properties 读取 <模块>_PACKAGE_VERSION 钉版本（四段或三段数字版本）。 */
export function parsePinnedModuleVersions(text: string): Map<string, string> {
  const pinned = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z][a-z0-9_]*)_PACKAGE_VERSION\s*=\s*(\S+)$/.exec(line);
    if (!match || !PINNED_VERSION.test(match[2]!)) continue;
    pinned.set(match[1]!, match[2]!);
  }
  return pinned;
}

type ResolvedModule = {
  module: string;
  repositoryId: string;
  ref: string;
  commit: string;
  snapshot: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在 per-module tag 中定位钉版本对应的不可变 commit；正式 tag 优先于 SNAPSHOT，同形态取最大构建号。 */
async function resolveModuleTag(
  client: GitLabArchiveClient,
  repositoryId: string,
  module: string,
  version: string,
  signal?: AbortSignal,
): Promise<ResolvedModule | null> {
  const tags = await client.searchTags(repositoryId, `${module}-V${version}`, signal);
  const pattern = new RegExp(`^${escapeRegExp(module)}-V${escapeRegExp(version)}(-SNAPSHOT)?-(\\d+)$`);
  // 钉版本本身带 -SNAPSHOT 后缀时，tag 中段不再有 SNAPSHOT 标记，但本质仍是快照构建
  const pinnedSnapshot = /-SNAPSHOT$/i.test(version);
  const candidates = tags.flatMap((tag) => {
    const match = pattern.exec(tag.name);
    return match ? [{ ref: tag.name, commit: tag.commit, snapshot: Boolean(match[1]) || pinnedSnapshot, build: Number(match[2]) }] : [];
  });
  if (!candidates.length) return null;
  const releases = candidates.filter((candidate) => !candidate.snapshot);
  const pool = releases.length ? releases : candidates;
  const best = pool.reduce((current, candidate) => (candidate.build > current.build ? candidate : current));
  return { module, repositoryId, ref: best.ref, commit: best.commit, snapshot: best.snapshot };
}

/**
 * 安卓组件解析：壳工程快照的 settings.gradle 声明本地组件（../仓库目录/模块），
 * gradle.properties 钉住各组件版本；per-module tag 定位 commit。
 * 发布列车下同版本模块共享 commit——按（仓库, commit）分组，每组只物化一份快照。
 */
export async function resolveAndroidComponents(options: {
  workspacePath: string;
  client: GitLabArchiveClient | null;
  rules: AndroidComponentRules;
  signal?: AbortSignal;
}): Promise<{ repositories: VersionRegistryRepository[]; limitations: string[] }> {
  let settings: string;
  let properties: string;
  try {
    settings = await readFile(join(options.workspacePath, 'settings.gradle'), 'utf8');
  } catch {
    return { repositories: [], limitations: ['主工程缺少 settings.gradle，无法解析安卓组件。'] };
  }
  try {
    properties = await readFile(join(options.workspacePath, 'gradle.properties'), 'utf8');
  } catch {
    return { repositories: [], limitations: ['主工程缺少 gradle.properties，无法读取组件钉版本。'] };
  }
  const localModules = parseSettingsGradleModules(settings);
  if (!localModules.length) {
    return { repositories: [], limitations: ['主工程未声明本地组件目录，组件来源无法定位。'] };
  }
  const pinned = parsePinnedModuleVersions(properties);
  const limitations: string[] = [];
  const unmappedRepos = new Set<string>();
  const unpinned: string[] = [];
  const resolvable: Array<{ module: string; repositoryId: string; version: string }> = [];
  for (const { repoDir, module } of localModules) {
    const repositoryId = options.rules.repo_map[repoDir];
    if (!repositoryId) { unmappedRepos.add(repoDir); continue; }
    const version = pinned.get(module);
    if (!version) { unpinned.push(module); continue; }
    resolvable.push({ module, repositoryId, version });
  }
  if (unmappedRepos.size) limitations.push(`以下组件目录未配置仓库映射，未挂载：${[...unmappedRepos].join('、')}。`);
  if (unpinned.length) limitations.push(`以下组件没有钉版本（gradle.properties），未挂载：${unpinned.join('、')}。`);
  const maxComponents = options.rules.max_components ?? 40;
  if (resolvable.length > maxComponents) {
    limitations.push(`组件数量超过上限 ${maxComponents}，未处理：${resolvable.slice(maxComponents).map((item) => item.module).join('、')}。`);
  }
  const resolved: ResolvedModule[] = [];
  // 分批请求，避免大清单打满 GitLab。
  for (let offset = 0; offset < Math.min(resolvable.length, maxComponents); offset += 4) {
    options.signal?.throwIfAborted();
    const batch = resolvable.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(async ({ module, repositoryId, version }) => {
      if (!options.client) throw new Error('未配置 GitLab API 凭据');
      const tag = await resolveModuleTag(options.client, repositoryId, module, version, options.signal);
      if (!tag) throw new Error(`仓库没有 ${module}-V${version} 的发布 tag`);
      return tag;
    }));
    options.signal?.throwIfAborted();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') resolved.push(result.value);
      else limitations.push(`${batch[index]!.module} 未挂载：${result.reason instanceof Error ? result.reason.message : '解析失败'}。`);
    });
  }
  // 发布列车：同仓库同 commit 的模块共享一份快照。
  const groups = new Map<string, { repositoryId: string; commit: string; ref: string; modules: string[]; snapshot: boolean }>();
  for (const item of resolved) {
    const key = `${item.repositoryId}@${item.commit}`;
    const group = groups.get(key) ?? { repositoryId: item.repositoryId, commit: item.commit, ref: item.ref, modules: [], snapshot: false };
    group.modules.push(item.module);
    group.snapshot = group.snapshot || item.snapshot;
    groups.set(key, group);
  }
  const repositories: VersionRegistryRepository[] = [];
  for (const group of groups.values()) {
    const repoName = group.repositoryId.split('/').pop()!;
    const sameRepoCount = [...groups.values()].filter((candidate) => candidate.repositoryId === group.repositoryId).length;
    const mount = sameRepoCount === 1 ? `components/${repoName}` : `components/${repoName}__${group.commit.slice(0, 8)}`;
    repositories.push({
      repository_id: group.repositoryId,
      role: 'component',
      mount_path: mount,
      ref: group.ref,
      expected_commit: group.commit,
    });
    if (group.snapshot) limitations.push(`组件 ${group.modules.join('、')} 该版本只有 SNAPSHOT 构建 tag（${group.ref}），供实现对照。`);
  }
  return { repositories, limitations };
}
