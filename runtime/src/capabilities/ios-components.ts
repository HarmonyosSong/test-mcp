import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { GitLabArchiveClient } from './gitlab-archive.js';
import type { VersionRegistryRepository } from './version-registry.js';

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,149}$/;
const VERSION = /^\d+(?:\.\d+)+(?:[-+][A-Za-z0-9_.-]+)?$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const RulesSchema = z.object({ rules: z.array(z.object({
  prefix: z.string().regex(NAME),
  namespace: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  suffix: z.string().regex(/^[A-Za-z0-9_-]*$/),
  strip_suffix: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
})) });
export type IosComponentRules = z.infer<typeof RulesSchema>['rules'];

export async function loadIosComponentRules(path: string): Promise<IosComponentRules> {
  return RulesSchema.parse(parseYaml(await readFile(path, 'utf8'))).rules;
}

export type IosDependency = {
  name: string;
  version: string | null;
  basis: 'lockfile' | 'podfile-declaration';
  git?: string;
  commit?: string;
  tag?: string;
  conflict?: boolean;
};

/** Parse literal dependency data only. Never execute Ruby from a source snapshot. */
export function parseIosDependencies(podfile: string, lockfile?: string): IosDependency[] {
  const dependencies = new Map<string, IosDependency>();
  const add = (dependency: IosDependency) => {
    if (!NAME.test(dependency.name)) throw new Error('iOS 组件名无效');
    const previous = dependencies.get(dependency.name);
    if (previous && (previous.version && dependency.version && previous.version !== dependency.version
      || previous.git && dependency.git && previous.git !== dependency.git)) {
      dependencies.set(dependency.name, { ...previous, conflict: true });
    } else {
      dependencies.set(dependency.name, { ...previous, ...dependency, version: dependency.version ?? previous?.version ?? null });
    }
  };
  if (lockfile !== undefined) {
    const lock: unknown = parseYaml(lockfile, { maxAliasCount: 50 });
    if (!record(lock) || !Array.isArray(lock.PODS)) throw new Error('Podfile.lock 缺少 PODS 列表');
    for (const pod of lock.PODS) {
      const declarations = typeof pod === 'string' ? [pod] : record(pod) ? Object.keys(pod) : [];
      if (declarations.length !== 1) throw new Error('Podfile.lock PODS 条目无效');
      const match = /^([^ /()]+)(?:\/[^ ()]+)? \(([^ ()]+)\)$/.exec(declarations[0]!);
      if (!match || !VERSION.test(match[2]!)) throw new Error('Podfile.lock 组件版本无效');
      add({ name: match[1]!, version: match[2]!, basis: 'lockfile' });
    }
    for (const dependency of dependencies.values()) {
      const external = record(lock['EXTERNAL SOURCES']) ? lock['EXTERNAL SOURCES'][dependency.name] : undefined;
      const checkout = record(lock['CHECKOUT OPTIONS']) ? lock['CHECKOUT OPTIONS'][dependency.name] : undefined;
      let branchOnly = false;
      for (const source of [external, checkout]) {
        if (!record(source)) continue;
        if (typeof source[':git'] === 'string') {
          if (dependency.git && dependency.git !== source[':git']) dependency.conflict = true;
          dependency.git = source[':git'];
        }
        if (typeof source[':commit'] === 'string') dependency.commit = source[':commit'];
        if (typeof source[':tag'] === 'string') dependency.tag = source[':tag'];
        // A branch-only checkout is not an immutable release identity.
        if (source[':branch']) branchOnly = true;
      }
      if (branchOnly && !dependency.commit && !dependency.tag) dependency.conflict = true;
    }
  } else {
    let blockComment = false;
    for (const raw of podfile.split(/\r?\n/)) {
      if (/^=begin\b/.test(raw)) { blockComment = true; continue; }
      if (/^=end\b/.test(raw)) { blockComment = false; continue; }
      if (blockComment) continue;
      const line = stripComment(raw).trim();
      const match = /^(pod(?:_framework|_git|_xesapp|_xes_modules|_cloudlearn_hd|_cloudlearn|_other)?)\s*(?:\(\s*)?['"]([A-Za-z][A-Za-z0-9_.\/-]*)['"](.*)$/.exec(line);
      if (!match) continue;
      const helper = match[1]!;
      const baseName = match[2]!.split('/')[0]!;
      const name = helper === 'pod_cloudlearn_hd' ? `${baseName}_HD` : baseName;
      const tail = match[3]!;
      const declared = /^\s*,\s*['"]([^'"]+)['"]/.exec(tail)?.[1];
      const git = literalOption(tail, 'git');
      add({
        name,
        version: declared && VERSION.test(declared) ? declared : null,
        basis: 'podfile-declaration',
        ...(git ? { git } : {}),
        ...(literalOption(tail, 'commit') ? { commit: literalOption(tail, 'commit') } : {}),
        ...(literalOption(tail, 'tag') ? { tag: literalOption(tail, 'tag') } : {}),
        ...(literalOption(tail, 'branch') && !literalOption(tail, 'tag') && !literalOption(tail, 'commit') ? { conflict: true } : {}),
      });
    }
  }
  return [...dependencies.values()];
}

function literalOption(text: string, key: string): string | undefined {
  return new RegExp(`:${key}\\s*=>\\s*['"]([^'"]+)['"]`).exec(text)?.[1];
}

function stripComment(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === '\\' && quote) { index++; continue; }
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the configured GitLab host receives credentials; external URLs are not fetched. */
function gitlabRepository(raw: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const scp = /^git@([^:]+):(.+)$/.exec(raw);
  const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : raw);
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.hostname !== base.hostname
    || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))
    || url.search || url.hash || /\s/.test(raw)) throw new Error('组件仓库不是配置的 GitLab 地址');
  const path = decodeURIComponent(url.pathname).replace(/^\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)
    || path.split('/').some((part) => part === '.' || part === '..')) throw new Error('组件仓库路径无效');
  return path;
}

async function findPodfiles(root: string, depth = 0): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === 'Podfile')) return [join(root, 'Podfile')];
  if (depth >= 2) return [];
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['Pods', 'node_modules', 'build'].includes(entry.name)) continue;
    files.push(...await findPodfiles(join(root, entry.name), depth + 1));
  }
  return files;
}

export async function resolveIosComponents(options: {
  workspacePath: string;
  client: GitLabArchiveClient | null;
  gitlabBaseUrl: string;
  rules: IosComponentRules;
  signal?: AbortSignal;
  maxComponents?: number;
}): Promise<{ repositories: VersionRegistryRepository[]; limitations: string[] }> {
  const paths = await findPodfiles(options.workspacePath);
  if (paths.length !== 1) return { repositories: [], limitations: [paths.length ? '存在多个 Podfile，组件依赖范围不唯一。' : '主工程未包含 Podfile，无法自动解析 iOS 组件。'] };
  const podfilePath = paths[0]!;
  let lockfile: string | undefined;
  try { lockfile = await readFile(join(dirname(podfilePath), 'Podfile.lock'), 'utf8'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  const dependencies = parseIosDependencies(await readFile(podfilePath, 'utf8'), lockfile);
  const limitations: string[] = lockfile === undefined
    ? ['主工程未包含 Podfile.lock；组件取自 Podfile 的静态版本声明（可能位于未启用的分支），仅供实现对照，不能确认是现场实际打包版本。']
    : [];
  const mapped: Array<{ dependency: IosDependency; repositoryId: string }> = [];
  const unmapped: string[] = [];
  for (const dependency of dependencies) {
    const rule = options.rules.find((candidate) => dependency.name.startsWith(candidate.prefix));
    if (!dependency.git && !rule) { unmapped.push(dependency.name); continue; }
    try {
      const name = rule?.strip_suffix && dependency.name.endsWith(rule.strip_suffix)
        ? dependency.name.slice(0, -rule.strip_suffix.length) : dependency.name;
      const repositoryId = dependency.git
        ? gitlabRepository(dependency.git, options.gitlabBaseUrl)
        : `${rule!.namespace}/${name}${rule!.suffix}`;
      if (dependency.conflict) throw new Error('依赖版本冲突或只有可变分支');
      if (!dependency.version && !dependency.commit && !dependency.tag) throw new Error('只有本地路径或版本约束，缺少固定版本');
      mapped.push({ dependency, repositoryId });
    } catch (error) {
      limitations.push(`${dependency.name} 未挂载：${error instanceof Error ? error.message : '依赖无效'}。`);
    }
  }
  if (unmapped.length) limitations.push(`以下依赖没有源码仓库映射，未挂载：${unmapped.join('、')}。`);
  const maxComponents = options.maxComponents ?? 40;
  if (mapped.length > maxComponents) limitations.push(`组件数量超过本轮上限 ${maxComponents}，未处理：${mapped.slice(maxComponents).map((item) => item.dependency.name).join('、')}。`);
  const repositories: VersionRegistryRepository[] = [];
  // Bounded batches keep large Podfiles from flooding GitLab.
  for (let offset = 0; offset < Math.min(mapped.length, maxComponents); offset += 4) {
    options.signal?.throwIfAborted();
    const batch = mapped.slice(offset, Math.min(offset + 4, maxComponents));
    const results = await Promise.allSettled(batch.map(async ({ dependency, repositoryId }) => {
      if (!options.client) throw new Error('未配置 GitLab API 凭据');
      let commit = dependency.commit;
      const ref = dependency.tag ?? dependency.version ?? commit!;
      if (commit) {
        if (!COMMIT.test(commit)) throw new Error('组件 commit 不是完整 SHA');
      } else {
        const tag = await options.client.findTag(repositoryId, ref, options.signal);
        if (!tag) throw new Error(`仓库或精确 tag ${ref} 不存在或不可访问`);
        commit = tag.commit;
      }
      return { repository_id: repositoryId, role: 'component' as const, mount_path: `components/${dependency.name}`, ref, expected_commit: commit };
    }));
    options.signal?.throwIfAborted();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') repositories.push(result.value);
      else limitations.push(`${batch[index]!.dependency.name} 未挂载：${result.reason instanceof Error ? result.reason.message : '解析失败'}。`);
    });
  }
  return { repositories, limitations };
}
