import type { GitLabArchiveClient } from './gitlab-archive.js';
import {
  normalizeClientVersion,
  selectVersionRegistryEntry,
  VersionRegistryError,
  type VersionRegistry,
  type VersionRegistryBuild,
  type VersionRegistryEntry,
  type VersionSelection,
  type VersionSelectionInput,
} from './version-registry.js';

/** Repository identity comes from the registry; missing releases come from observed GitLab tags. */
export async function resolveVersionSource(
  registry: VersionRegistry,
  client: GitLabArchiveClient | null,
  input: VersionSelectionInput,
  signal?: AbortSignal,
): Promise<{ selection: VersionSelection; limitations: string[] }> {
  try {
    return { selection: registry.select(input), limitations: [] };
  } catch (error) {
    if (!(error instanceof VersionRegistryError) || !input.version
      || !['version_not_registered', 'build_not_registered'].includes(error.code)) throw error;
  }

  if (input.platform === 'android') return resolveAndroidSource(registry, client, input, signal);

  // Resolve the product/form before making any remote request. Never let the
  // model choose a repository or carry component commits across releases.
  const template = registry.select({
    platform: input.platform,
    productLine: input.productLine,
    formFactor: input.formFactor,
  });
  const version = normalizeClientVersion(input.version!);
  const shell = template.repositories.find((repository) => repository.role === 'shell')!;
  if (input.platform === 'harmony') {
    if (!client) {
      throw new VersionRegistryError('version_not_registered',
        `鸿蒙 ${version} 未登记，且未配置 HARMONY_AGENT_GITLAB_TOKEN（或 ANALYSIS_GIT_TOKEN），无法查询对应发布 tag 并下载源码快照；未改用其它版本`);
    }
    // Harmony release tags are the marketing version, without an independent
    // build identity. A supplied build must not silently match a version tag.
    if (input.build?.trim()) {
      throw new VersionRegistryError('build_not_registered',
        `鸿蒙 ${version} build ${input.build} 未登记；版本 tag 无法核实指定构建，未改用其它版本`);
    }
    const tag = await client.findTag(shell.repository_id, version, signal);
    if (!tag) {
      throw new VersionRegistryError('version_not_registered',
        `GitLab 仓库 ${shell.repository_id} 没有鸿蒙 ${version} 的精确发布 tag；未改用其它版本`);
    }
    const entry = { ...template.entry, version, builds: [{
      tag: tag.name, source: 'tag-scan' as const, verified: true,
      // Components from the template release are not evidence for this tag.
      repos: [{ ...shell, ref: tag.name, expected_commit: tag.commit }],
    }] };
    return { selection: selectVersionRegistryEntry([entry], input), limitations: [] };
  }
  const tagFormat = /^(.*_v)\d+\.\d+\.\d+_\d+_\d{8}$/.exec(template.build.tag);
  let discovery = '当前仓库没有配置可识别的发布 tag 格式';
  if (input.platform === 'ios' && tagFormat && client) {
    const prefix = `${tagFormat[1]}${version}_`;
    const tags = await client.searchTags(shell.repository_id, version, signal);
    const builds: VersionRegistryBuild[] = tags.flatMap((tag) => {
      if (!tag.name.startsWith(prefix)) return [];
      const suffix = /^(\d+)_(\d{8})$/.exec(tag.name.slice(prefix.length));
      if (!suffix) return [];
      return [{
        build: suffix[1],
        tag: tag.name,
        source: 'tag-scan' as const,
        verified: true,
        repos: [{ ...shell, ref: tag.name, expected_commit: tag.commit }],
      }];
    });
    const matchingBuilds = input.build ? builds.filter((build) => build.build === input.build) : builds;
    if (matchingBuilds.length > 0) {
      const entry = { ...template.entry, version, builds: matchingBuilds };
      return { selection: selectVersionRegistryEntry([entry], input), limitations: [] };
    }
    discovery = `已查询 GitLab 仓库 ${shell.repository_id}，没有匹配的发布 tag`;
  } else if (!client) {
    discovery = '未配置 GitLab API 凭据，无法动态查询发布 tag';
  }
  return {
    selection: template,
    limitations: [
      `现场版本 ${input.version}${input.build ? ` build ${input.build}` : ''} 未登记；${discovery}。当前绑定 ${template.entry.version} build ${template.build.build ?? 'unknown'}（${template.build.tag}）作为源码对照，不能据此确认现场版本行为。`,
    ],
  };
}

async function resolveAndroidSource(
  registry: VersionRegistry,
  client: GitLabArchiveClient | null,
  input: VersionSelectionInput,
  signal?: AbortSignal,
): Promise<{ selection: VersionSelection; limitations: string[] }> {
  const version = normalizeClientVersion(input.version!);
  if (!client) {
    throw new VersionRegistryError('version_not_registered',
      `安卓 ${version} 未登记，且未配置 HARMONY_AGENT_GITLAB_TOKEN（或 ANALYSIS_GIT_TOKEN），无法查询发布 tag 并下载源码；未改用其它版本`);
  }
  // The exact version may exist only in a phone or pad repository. Discover
  // within registered scopes before declaring a missing form ambiguous; never
  // infer a repository from a version's major number or from a model URL.
  const scopes = new Map<string, VersionRegistryEntry>();
  for (const entry of registry.entries()) {
    if (entry.platform !== 'android'
      || (input.productLine && entry.product_line !== input.productLine)
      || (input.formFactor && entry.form_factor !== input.formFactor && entry.form_factor !== 'universal')) continue;
    scopes.set(`${entry.product_line}/${entry.form_factor ?? 'universal'}`, entry);
  }
  const results = await Promise.allSettled([...scopes.values()].map(async (scope) => {
    const template = registry.select({ platform: 'android', productLine: scope.product_line, formFactor: scope.form_factor });
    const shell = template.repositories.find((repository) => repository.role === 'shell')!;
    const tags = await client.searchTags(shell.repository_id, version, signal);
    const builds: VersionRegistryBuild[] = tags.flatMap((tag) => {
      const match = /^V(\d+\.\d+\.\d+)-(\d+)-(TEST|CUSTOM|GOD)$/i.exec(tag.name);
      if (!match || match[1] !== version || (input.build?.trim() && match[2] !== input.build.trim())) return [];
      return [{
        build: match[2], tag: tag.name, source: 'tag-scan' as const, verified: true,
        repos: [{ ...shell, ref: tag.name, expected_commit: tag.commit }],
      }];
    });
    return { ...template.entry, version, builds };
  }));
  // A failed candidate repository is not evidence that its version is absent.
  const candidates: VersionRegistryEntry[] = [];
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    if (result.value.builds.length) candidates.push(result.value);
  }
  if (!candidates.length) {
    throw new VersionRegistryError(input.build ? 'build_not_registered' : 'version_not_registered',
      `已查询登记范围内的安卓仓库，没有 ${version}${input.build ? ` build ${input.build}` : ''} 的匹配发布 tag；未改用其它版本`);
  }
  const selection = selectVersionRegistryEntry(candidates, input);
  const sameBuild = selection.entry.builds.filter((build) => build.build === selection.build.build);
  if (new Set(sameBuild.map((build) => build.repos.find((repo) => repo.role === 'shell')!.expected_commit)).size > 1) {
    throw new VersionRegistryError('version_ambiguous',
      `安卓 ${version} build ${selection.build.build} 的多个类型 tag 指向不同 commit，无法唯一绑定：${sameBuild.map((build) => build.tag).join('、')}`);
  }
  return {
    selection,
    limitations: input.build?.trim() ? [] : [
      `未提供现场构建号；已选择安卓 ${version} 同版本最新构建 ${selection.build.build}（${selection.build.tag}），尚未确认与现场安装包的构建一致。`,
    ],
  };
}
