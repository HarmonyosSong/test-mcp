/**
 * 版本登记表回填：按 code-index/sources.json 的窗口版本，查询 GitLab 发布 tag，
 * 把缺失的（平台/产品线/形态/版本）补写进 version-registry/ 对应 yaml。
 *
 * 规则与运行时 version-source.ts 的动态发现保持一致：
 *   - 鸿蒙：精确版本 tag（无独立构建号）
 *   - 安卓：V{version}-{build}-TEST|CUSTOM|GOD，同版本取最大 build
 *   - iOS ：从已有登记条目的 tag 学习前缀（如 XesApp_v / XesAppHD_v），匹配
 *           {前缀}{version}_{build}_{yyyyMMdd}
 * 仓库身份只来自已有登记条目（同文件同主版本优先），脚本不猜测新仓库。
 *
 * 用法：npx tsx code-index/backfill-registry.ts [--dry-run]
 * 需要 .env 配置 HARMONY_AGENT_GITLAB_TOKEN（或 ANALYSIS_GIT_TOKEN）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GitLabArchiveClient } from '../runtime/src/capabilities/gitlab-archive.js';
import {
  loadVersionRegistry,
  loadVersionRegistryFile,
  normalizeClientVersion,
  selectVersionRegistryEntry,
  type VersionRegistryBuild,
  type VersionRegistryEntry,
} from '../runtime/src/capabilities/version-registry.js';
import { loadRuntimeConfig } from '../runtime/src/config.js';

type Profile = {
  platform: 'harmony' | 'android' | 'ios';
  product_line: 'xueersi' | 'xuejiayun';
  form_factor: 'phone' | 'pad' | 'universal';
  versions: string[];
};

type BackfillBuild = {
  build: string | null;
  tag: string;
  commit: string;
};

type Outcome =
  | { status: 'skip'; reason: string }
  | { status: 'backfill'; builds: BackfillBuild[]; repositoryId: string }
  | { status: 'miss'; reason: string };

const dryRun = process.argv.includes('--dry-run');
const root = resolve(import.meta.dirname, '..');
const config = loadRuntimeConfig();
if (!config.gitlabToken) throw new Error('未配置 GitLab 凭据，在 .env 配置 HARMONY_AGENT_GITLAB_TOKEN 后再运行');
const client = new GitLabArchiveClient({
  baseUrl: config.gitlabBaseUrl,
  token: config.gitlabToken,
  timeoutMs: config.gitlabTimeoutMs,
});

const { profiles } = JSON.parse(
  await readFile(resolve(root, 'code-index/sources.json'), 'utf8'),
) as { profiles: Profile[] };
const registryRoot = resolve(root, config.versionRegistryRoot);
const entries = await loadVersionRegistry(registryRoot);

/** 登记表中已满足该窗口版本（精确形态或 universal 兜底，且有已核验构建）。 */
function isRegistered(profile: Profile, version: string): boolean {
  return entries.some((entry) =>
    entry.platform === profile.platform
    && entry.product_line === profile.product_line
    && normalizeClientVersion(entry.version) === version
    && (entry.form_factor === profile.form_factor
      || entry.form_factor === 'universal'
      || profile.form_factor === 'universal')
    && entry.builds.some((build) => build.verified));
}

/** 壳仓库模板：同平台同产品线内，同形态优先、同主版本次之；并列则视为歧义。 */
function selectTemplate(profile: Profile, version: string): VersionRegistryEntry | { error: string } {
  const candidates = entries.filter((entry) =>
    entry.platform === profile.platform && entry.product_line === profile.product_line);
  if (candidates.length === 0) {
    return { error: `${profile.platform}/${profile.product_line} 没有任何已登记条目，无法推断壳仓库` };
  }
  const scored = candidates.map((entry) => ({
    entry,
    score: (entry.form_factor === profile.form_factor ? 2 : 0)
      + (entry.version.split('.')[0] === version.split('.')[0] ? 1 : 0),
  }));
  const best = Math.max(...scored.map((item) => item.score));
  const top = scored.filter((item) => item.score === best);
  if (top.length > 1) {
    return { error: `模板歧义：${top.map((item) => `${item.entry.version}/${item.entry.form_factor}`).join('、')} 均可作模板` };
  }
  return top[0]!.entry;
}

/** 与运行时 version-source.ts 相同的 tag 发现规则，返回该版本可选构建（新→旧）。 */
async function discoverBuilds(
  profile: Profile,
  version: string,
  template: VersionRegistryEntry,
): Promise<BackfillBuild[] | { error: string }> {
  const shell = template.builds
    .flatMap((build) => build.repos)
    .find((repository) => repository.role === 'shell');
  if (!shell) return { error: '模板条目缺少 shell 仓库' };

  if (profile.platform === 'harmony') {
    const tag = await client.findTag(shell.repository_id, version);
    return tag
      ? [{ build: null, tag: tag.name, commit: tag.commit }]
      : { error: `GitLab 仓库 ${shell.repository_id} 没有 ${version} 的精确发布 tag` };
  }

  const tags = await client.searchTags(shell.repository_id, version);
  if (profile.platform === 'android') {
    const pattern = new RegExp(`^V${version.replaceAll('.', '\\.')}-(\\d+)-(TEST|CUSTOM|GOD)$`, 'i');
    const byBuild = new Map<string, { tag: string; commit: string; rank: number }>();
    for (const tag of tags) {
      const match = pattern.exec(tag.name);
      if (!match) continue;
      // 同 build 多类型（TEST/CUSTOM/GOD）应指向同一 commit；发布类型优先 GOD>CUSTOM>TEST。
      const rank = { GOD: 3, CUSTOM: 2, TEST: 1 }[match[2]!.toUpperCase() as 'GOD' | 'CUSTOM' | 'TEST'];
      const existing = byBuild.get(match[1]!);
      if (existing && existing.commit !== tag.commit) {
        return { error: `build ${match[1]} 的多个类型 tag 指向不同 commit：${existing.tag}、${tag.name}` };
      }
      if (!existing || rank > existing.rank) byBuild.set(match[1]!, { tag: tag.name, commit: tag.commit, rank });
    }
    const builds = [...byBuild.entries()]
      .sort((left, right) => Number(right[0]) - Number(left[0]))
      .map(([build, value]) => ({ build, tag: value.tag, commit: value.commit }));
    return builds.length > 0
      ? builds.slice(0, 1)
      : { error: `GitLab 仓库 ${shell.repository_id} 没有 ${version} 的匹配发布 tag` };
  }

  // iOS：从模板 tag 学习仓库的发布前缀，避免把前缀规则硬编码进脚本。
  const tagFormat = /^(.*_v)\d+\.\d+\.\d+_\d+_\d{8}$/.exec(template.builds[0]?.tag ?? '');
  if (!tagFormat) return { error: `模板 tag（${template.builds[0]?.tag ?? '无'}）格式不可识别，无法推断 iOS 发布前缀` };
  const prefix = `${tagFormat[1]}${version}_`;
  const builds: BackfillBuild[] = tags.flatMap((tag) => {
    if (!tag.name.startsWith(prefix)) return [];
    const suffix = /^(\d+)_(\d{8})$/.exec(tag.name.slice(prefix.length));
    return suffix ? [{ build: suffix[1]!, tag: tag.name, commit: tag.commit }] : [];
  });
  builds.sort((left, right) => Number(right.build) - Number(left.build));
  return builds.length > 0
    ? builds.slice(0, 1)
    : { error: `GitLab 仓库 ${shell.repository_id} 没有匹配 ${prefix}* 的发布 tag` };
}

/** 序列化值只允许安全字符，避免手写 YAML 产生转义问题。 */
function yamlSafe(value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error(`值含需转义字符，拒绝手写 YAML：${value}`);
  return value;
}

/** 与现有登记表一致的 2 空格缩进格式；mount_path 为空时省略（schema 默认 ''）。 */
function serializeEntries(fileEntries: VersionRegistryEntry[]): string {
  const lines: string[] = [];
  for (const entry of fileEntries) {
    lines.push(`- version: ${yamlSafe(entry.version)}`);
    lines.push(`  form_factor: ${yamlSafe(entry.form_factor ?? 'universal')}`);
    lines.push('  builds:');
    for (const build of entry.builds) {
      lines.push(build.build == null ? '    -' : `    - build: "${yamlSafe(build.build)}"`);
      lines.push(`      tag: ${yamlSafe(build.tag)}`);
      lines.push(`      source: ${build.source}`);
      lines.push(`      verified: ${build.verified}`);
      lines.push('      repos:');
      for (const repository of build.repos) {
        lines.push(`        - repository_id: ${yamlSafe(repository.repository_id)}`);
        lines.push(`          role: ${repository.role}`);
        if (repository.mount_path) lines.push(`          mount_path: ${yamlSafe(repository.mount_path)}`);
        lines.push(`          ref: ${yamlSafe(repository.ref)}`);
        lines.push(`          expected_commit: ${yamlSafe(repository.expected_commit)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const planned = new Map<string, VersionRegistryEntry[]>();
const report: string[] = [];

for (const profile of profiles) {
  for (const rawVersion of profile.versions) {
    const version = normalizeClientVersion(rawVersion);
    const key = `${profile.platform}/${profile.product_line}/${profile.form_factor}/${version}`;
    if (isRegistered(profile, version)) {
      report.push(`SKIP  ${key}（已登记）`);
      continue;
    }
    const template = selectTemplate(profile, version);
    if ('error' in template) {
      report.push(`MISS  ${key}（${template.error}）`);
      continue;
    }
    let discovered: BackfillBuild[] | { error: string };
    try {
      discovered = await discoverBuilds(profile, version, template);
    } catch (error) {
      report.push(`MISS  ${key}（GitLab 查询失败：${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }
    if ('error' in discovered) {
      report.push(`MISS  ${key}（${discovered.error}）`);
      continue;
    }
    // 鸿蒙/iOS 现有文件统一用 universal；安卓按窗口形态登记 phone/pad。
    const formFactor = profile.platform === 'android' ? profile.form_factor : 'universal';
    const shell = template.builds
      .flatMap((build) => build.repos)
      .find((repository) => repository.role === 'shell')!;
    const entry: VersionRegistryEntry = {
      platform: profile.platform,
      product_line: profile.product_line,
      version,
      form_factor: formFactor,
      builds: discovered.map((build): VersionRegistryBuild => ({
        build: build.build,
        tag: build.tag,
        source: 'tag-scan',
        verified: true,
        repos: [{ repository_id: shell.repository_id, role: 'shell', mount_path: '', ref: build.tag, expected_commit: build.commit }],
      })),
    };
    const filePath = resolve(registryRoot, profile.platform, `${profile.product_line}.yaml`);
    planned.set(filePath, [...(planned.get(filePath) ?? []), entry]);
    report.push(`ADD   ${key} → ${discovered.map((build) => `${build.tag}@${build.commit.slice(0, 8)}`).join('、')}`);
  }
}

console.log(report.join('\n'));

if (planned.size === 0) {
  console.log('\n没有需要回填的版本。');
  process.exit(0);
}
if (dryRun) {
  console.log(`\n--dry-run：不落盘。共 ${[...planned.values()].flat().length} 个条目待写入 ${planned.size} 个文件。`);
  process.exit(0);
}

for (const [filePath, additions] of planned) {
  const existing = await loadVersionRegistryFile(
    filePath,
    additions[0]!.platform,
    additions[0]!.product_line,
  );
  const merged = [...existing, ...additions].sort((left, right) =>
    right.version.localeCompare(left.version, 'en-US', { numeric: true }));
  await writeFile(filePath, serializeEntries(merged), 'utf8');
  console.log(`已写入 ${filePath}（新增 ${additions.length} 条）`);
}

// 回读校验：序列化结果必须能通过登记表 schema，且每个新条目可被选择。
const reloaded = await loadVersionRegistry(registryRoot);
for (const additions of planned.values()) {
  for (const entry of additions) {
    selectVersionRegistryEntry(reloaded, {
      platform: entry.platform,
      productLine: entry.product_line,
      formFactor: entry.form_factor,
      version: entry.version,
    });
  }
}
console.log('回读校验通过：所有新条目可被登记表选择。');
