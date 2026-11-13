import type { GitLabArchiveClient } from './gitlab-archive.js';
import {
  normalizeClientVersion,
  selectVersionRegistryEntry,
  VersionRegistryError,
  type VersionRegistry,
  type VersionRegistryBuild,
  type VersionSelection,
  type VersionSelectionInput,
} from './version-registry.js';

/** Repository identity comes from the registry; missing iOS releases come from observed GitLab tags. */
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

  // Resolve the product/form before making any remote request. Never let the
  // model choose a repository or carry component commits across releases.
  const template = registry.select({
    platform: input.platform,
    productLine: input.productLine,
    formFactor: input.formFactor,
  });
  const version = normalizeClientVersion(input.version!);
  const shell = template.repositories.find((repository) => repository.role === 'shell')!;
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
