import { resolve } from 'node:path';

import type { GitLabArchiveClient } from './gitlab-archive.js';
import { loadAndroidComponentRules, resolveAndroidComponents } from './android-components.js';
import { loadIosComponentRules, resolveIosComponents } from './ios-components.js';
import type { VersionRegistryRepository } from './version-registry.js';

/**
 * 平台组件解析与物化：运行时绑定（app.ts）与离线索引生成（code-index/prepare-sources.ts）
 * 共用同一条链路，保证诊断现场与 code-index 看到的源码范围一致。
 */

/**
 * 在壳工程快照之上解析平台组件清单：登记表已声明的组件保留，
 * iOS 再按 Podfile(.lock)、安卓再按 settings.gradle + gradle.properties 补充推断组件。
 */
export async function resolvePlatformComponents(options: {
  platform: 'harmony' | 'android' | 'ios';
  shellWorkspacePath: string;
  selectionRepositories: VersionRegistryRepository[];
  client: GitLabArchiveClient | null;
  gitlabBaseUrl: string;
  contractsDir: string;
  signal?: AbortSignal;
}): Promise<{ componentRepositories: VersionRegistryRepository[]; limitations: string[] }> {
  const limitations: string[] = [];
  const componentRepositories = options.selectionRepositories.filter((item) => item.role !== 'shell');
  if (options.platform === 'ios') {
    try {
      const components = await resolveIosComponents({
        workspacePath: options.shellWorkspacePath,
        client: options.client,
        gitlabBaseUrl: options.gitlabBaseUrl,
        rules: await loadIosComponentRules(resolve(options.contractsDir, 'ios-components.yaml')),
        signal: options.signal,
      });
      limitations.push(...components.limitations);
      // Explicit registry mappings take precedence over inferred dependencies.
      for (const component of components.repositories) {
        if (!options.selectionRepositories.some((item) => item.repository_id === component.repository_id)) componentRepositories.push(component);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      limitations.push(`iOS 组件解析失败，保留主工程：${error instanceof Error ? error.message : '未知错误'}。`);
    }
  }
  if (options.platform === 'android') {
    try {
      const components = await resolveAndroidComponents({
        workspacePath: options.shellWorkspacePath,
        client: options.client,
        rules: await loadAndroidComponentRules(resolve(options.contractsDir, 'android-components.yaml')),
        signal: options.signal,
      });
      limitations.push(...components.limitations);
      for (const component of components.repositories) {
        if (!componentRepositories.some((item) => item.repository_id === component.repository_id && item.expected_commit === component.expected_commit)) componentRepositories.push(component);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      limitations.push(`安卓组件解析失败，保留主工程：${error instanceof Error ? error.message : '未知错误'}。`);
    }
  }
  return { componentRepositories, limitations };
}

/** 分批物化组件快照；单个组件失败不拖垮整批，缺口如实记录。 */
export async function materializeComponentSnapshots<T>(options: {
  componentRepositories: VersionRegistryRepository[];
  prepareRepository: (registryRepository: VersionRegistryRepository) => Promise<T>;
  signal?: AbortSignal;
}): Promise<{ snapshots: T[]; limitations: string[] }> {
  const snapshots: T[] = [];
  const limitations: string[] = [];
  for (let offset = 0; offset < options.componentRepositories.length; offset += 4) {
    options.signal?.throwIfAborted();
    const batch = options.componentRepositories.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(options.prepareRepository));
    options.signal?.throwIfAborted();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') snapshots.push(result.value);
      else limitations.push(`组件 ${batch[index]!.repository_id}@${batch[index]!.ref} 下载失败，保留其它源码：${result.reason instanceof Error ? result.reason.message : '未知错误'}。`);
    });
  }
  return { snapshots, limitations };
}
