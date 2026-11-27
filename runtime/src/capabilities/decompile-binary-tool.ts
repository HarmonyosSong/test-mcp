import { z } from 'zod';

import { createTool } from '@mastra/core/tools';

import type { ConversationRecord } from '../domain/schemas.js';
import {
  decompileBinary,
  DecompileBinaryError,
  readDecompiledClass,
  searchDecompiledOutput,
  type JadxRunner,
} from './decompile-binary.js';

/**
 * decompile_binary：快照内三方 SDK 二进制（aar/jar/dex）的反编译查询工具。
 *
 * 壳工程 libs/ 下的 SDK 只有二进制，其内部行为（安装检测、包可见性、TLS 校验等）
 * 是源码快照的盲区。工具用 jadx 反编译（产物按内容哈希缓存复用），返回高风险
 * API 行为索引；模型再用 class_name/search 参数按需读取具体类源码。
 *
 * 工具合同与 prepare_source 一致：不可用/失败一律返回可读 limitation，不裸抛。
 */
export function createDecompileBinaryTool(options: {
  conversation: ConversationRecord;
  jadxPath: string;
  cacheRoot: string;
  abortSignal?: AbortSignal;
  runner?: JadxRunner;
}): ReturnType<typeof createTool> {
  const { conversation, jadxPath, cacheRoot, abortSignal, runner } = options;
  // 轮内缓存最近一次产物目录：class_name/search 缺省作用于同一二进制。
  let lastCacheDir: string | null = null;

  return createTool({
    id: 'decompile_binary',
    description:
      '反编译快照内三方 SDK 二进制（libs/ 下的 .aar/.jar/.dex），还原其内部实现：' +
      '返回高风险 API 行为索引（安装检测/包可见性、权限、反射、网络 TLS、WebView、Intent 拉起、加解密）与 manifest 权限声明。' +
      'SDK 内部行为（如「检测 App 是否安装」「是否走 H5 兜底」）在源码快照里不可见、需要确定性证据时使用。' +
      '传 class_name 读取某个类的完整反编译源码；传 search 在全部产物中搜索文本。产物按内容哈希缓存，重复调用秒回。',
    inputSchema: z.object({
      relative_path: z.string().min(1).optional().describe(
        '快照内二进制路径（相对已绑定 workspace 根），如 purchase/libs/cmbsdk-release-1.1.0.aar；' +
          '从 build.gradle 的 files(\'libs/xxx\') 引用得到的无后缀文件名可直接传入，工具自动补全扩展名。' +
          '首次使用必传（执行反编译并返回行为索引），后续 class_name/search 查询可省略（复用同一会话最近产物）',
      ),
      class_name: z.string().optional().describe(
        '读取指定类的完整反编译源码（点号类名，如 cmbapi.a 或 cmbapi.a.a）；需先对同一会话反编译过，或配合 relative_path',
      ),
      search: z.string().optional().describe(
        '在反编译产物中做大小写不敏感文本搜索（如 getInstalledPackages）；需先反编译过，或配合 relative_path',
      ),
    }),
    execute: async (args) => {
      abortSignal?.throwIfAborted();
      const workspacePath = conversation.workspace_path;
      if (!workspacePath) {
        return {
          status: 'unbound',
          limitation: '尚未绑定源码快照，无法定位 SDK 二进制。先调用 prepare_source 绑定版本快照。',
        };
      }
      if (!args.relative_path && !lastCacheDir) {
        return {
          status: 'unresolved',
          limitation: '尚未反编译过任何二进制：请传 relative_path（如 purchase/libs/xxx.aar）指定目标。',
        };
      }

      try {
        let cacheDir = lastCacheDir;
        let binaryInfo: Record<string, unknown> | null = null;

        if (args.relative_path) {
          const result = await decompileBinary({
            workspacePath,
            relativePath: args.relative_path,
            jadxPath,
            cacheRoot,
            signal: abortSignal,
            runner,
          });
          cacheDir = result.cacheDir;
          lastCacheDir = cacheDir;
          binaryInfo = {
            binary: result.resolvedRelativePath,
            ...(result.autoCompleted ? { auto_completed_from: args.relative_path } : {}),
            sha256: result.sha256.slice(0, 12),
            cached: result.cached,
            classes: result.summary.classes,
            manifest: result.summary.manifest,
            risk_index: Object.fromEntries(
              result.summary.riskIndex.map(({ key, label, hits }) => [
                `${key}（${label}）`,
                hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`),
              ]),
            ),
            ...(result.summary.truncated ? { risk_index_truncated: true } : {}),
          };
        }

        const sections: Record<string, unknown> = { status: 'decompiled' };
        if (binaryInfo) sections.binary_info = binaryInfo;

        if (args.class_name) {
          const klass = await readDecompiledClass(cacheDir!, args.class_name);
          sections.class_source = {
            path: klass.path,
            truncated: klass.truncated,
            content: klass.content,
          };
        }
        if (args.search) {
          const found = await searchDecompiledOutput(cacheDir!, args.search);
          sections.search_result = {
            query: args.search,
            truncated: found.truncated,
            hits: found.hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`),
          };
        }
        if (!args.class_name && !args.search) {
          sections.usage = '行为索引仅列高风险 API 命中点；传 class_name 读某个类完整源码，传 search 全文搜索（如具体包名/方法名）。';
        }
        return sections;
      } catch (error) {
        abortSignal?.throwIfAborted();
        if (error instanceof DecompileBinaryError) {
          return {
            status: error.code === 'jadx_unavailable' ? 'unavailable' : 'unresolved',
            limitation: error.message,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: 'unresolved',
          limitation: `二进制反编译失败：${message}。可换具体类名/搜索词重试，或继续基于源码与日志分析。`,
        };
      }
    },
  });
}
