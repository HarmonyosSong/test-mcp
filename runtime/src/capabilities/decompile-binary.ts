import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

/**
 * 三方 SDK 二进制（aar/jar/dex）反编译能力。
 *
 * 快照里 libs/ 下的二进制不在源码内，SDK 内部行为（安装检测、包可见性、TLS 校验…）
 * 对诊断是盲区。本能力用 jadx 把二进制反编译成 Java 文本，产物按内容哈希缓存到
 * <cacheRoot>/decompiled/<sha256>/，跨版本跨会话复用；并在产物上跑高风险 API
 * 规则扫描生成行为索引，让模型一眼看到「这个 SDK 用了 getInstalledPackages」。
 *
 * 边界：输入路径必须落在已绑定 workspace 内；jadx 由本模块 spawn（与 prepare_source
 * 内部跑 git 同模式），agent 侧只拿到结构化文本，不获得 shell。
 */

export class DecompileBinaryError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'jadx_unavailable' | 'decompile_failed' | 'not_found',
  ) {
    super(message);
    this.name = 'DecompileBinaryError';
  }
}

export type JadxRunner = (options: {
  jadxPath: string;
  inputPath: string;
  outputDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<void>;

/** 默认 runner：spawn jadx CLI（-d 输出目录，--no-debug-info 降噪）。 */
export const spawnJadxRunner: JadxRunner = ({ jadxPath, inputPath, outputDir, timeoutMs, signal }) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      jadxPath,
      ['-d', outputDir, '--no-debug-info', '--no-imports', inputPath],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise();
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new DecompileBinaryError(
            `未找到 jadx（${jadxPath}）；请安装 jadx 或配置 HARMONY_AGENT_JADX_PATH。`,
            'jadx_unavailable',
          ));
          return;
        }
        reject(new DecompileBinaryError(
          `jadx 反编译失败：${String(stderr).slice(0, 300) || error.message}`,
          'decompile_failed',
        ));
      },
    );
  });

/** 高风险 API 规则清单：每类按诊断价值命名，命中即列入行为索引。 */
const RISK_PATTERNS: Array<{ key: string; label: string; pattern: RegExp }> = [
  {
    key: 'package-visibility',
    label: '安装检测/包可见性',
    pattern: /getInstalledPackages|getInstalledApplications|getPackageInfo|getApplicationInfo|queryIntentActivities|queryIntentServices|resolveActivity/,
  },
  {
    key: 'permission',
    label: '权限检查',
    pattern: /checkSelfPermission|checkPermission|requestPermissions|shouldShowRequestPermissionRationale/,
  },
  {
    key: 'reflection-dynamic',
    label: '反射/动态加载',
    pattern: /Class\.forName|getDeclaredMethod|DexClassLoader|PathClassLoader|System\.loadLibrary|loadClass\(/,
  },
  {
    key: 'network-tls',
    label: '网络/TLS 校验',
    pattern: /HostnameVerifier|X509TrustManager|checkServerTrusted|SSLSocketFactory|OkHttpClient|HttpURLConnection/,
  },
  {
    key: 'webview',
    label: 'WebView 交互',
    pattern: /addJavascriptInterface|setJavaScriptEnabled|loadUrl|shouldOverrideUrlLoading|WebViewClient/,
  },
  {
    key: 'intent-launch',
    label: 'Intent/组件拉起',
    pattern: /startActivity|setPackage\(|setClassName|new ComponentName|setData\(/,
  },
  {
    key: 'crypto',
    label: '加解密',
    pattern: /Cipher\.getInstance|SecretKeySpec|MessageDigest\.getInstance/,
  },
];

const PER_CATEGORY_LIMIT = 15;
const TOTAL_HIT_LIMIT = 80;
const HIT_LINE_MAX = 120;
const CLASS_MAX_CHARS = 30_000;
const SEARCH_HIT_LIMIT = 30;

const BINARY_EXTENSIONS = new Set(['.aar', '.jar', '.dex']);
const DONE_MARKER = '.decompile-done';

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** 解析并校验快照内二进制路径：必须在 workspace 内且扩展名受支持。 */
export function resolveBinaryPath(workspacePath: string, relativePath: string): string {
  const workspace = resolve(workspacePath);
  const target = resolve(workspace, relativePath);
  if (!isWithin(workspace, target)) {
    throw new DecompileBinaryError(`二进制路径越界：${relativePath}（必须在已绑定快照内）`, 'invalid_input');
  }
  const lower = relativePath.toLowerCase();
  if (![...BINARY_EXTENSIONS].some((ext) => lower.endsWith(ext))) {
    throw new DecompileBinaryError(
      `不支持的二进制类型：${relativePath}（仅支持 ${[...BINARY_EXTENSIONS].join('/')}）`,
      'invalid_input',
    );
  }
  return target;
}

export type ResolvedBinary = {
  absPath: string;
  /** 实际使用的 workspace 相对路径（自动补全扩展名后与入参可能不同）。 */
  relativePath: string;
  autoCompleted: boolean;
};

/**
 * 解析二进制路径，扩展名缺失/不受支持时自动补全：
 * 模型常从 build.gradle 的 files('libs/xxx') 引用得到无后缀文件名，而 list_project_files
 * 只列文本文件、永远列不出 .aar——补全必须在工具内做，否则模型被指引到死路。
 * 恰好一个同名二进制直接采用；多个列候选；零个附父目录实际清单帮助排错。
 */
export async function resolveBinaryWithFallback(
  workspacePath: string,
  relativePath: string,
): Promise<ResolvedBinary> {
  const workspace = resolve(workspacePath);
  const target = resolve(workspace, relativePath);
  if (!isWithin(workspace, target)) {
    throw new DecompileBinaryError(`二进制路径越界：${relativePath}（必须在已绑定快照内）`, 'invalid_input');
  }
  const lower = relativePath.toLowerCase();
  if ([...BINARY_EXTENSIONS].some((ext) => lower.endsWith(ext))) {
    return { absPath: target, relativePath, autoCompleted: false };
  }

  const parentAbs = dirname(target);
  const stem = basename(relativePath);
  let candidates: string[] = [];
  try {
    for (const entry of await readdir(parentAbs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!BINARY_EXTENSIONS.has(ext)) continue;
      if (entry.name.slice(0, entry.name.length - ext.length) === stem) candidates.push(entry.name);
    }
  } catch {
    candidates = [];
  }
  const parentRel = dirname(relativePath);
  if (candidates.length === 1) {
    return {
      absPath: join(parentAbs, candidates[0]!),
      relativePath: join(parentRel, candidates[0]!),
      autoCompleted: true,
    };
  }
  if (candidates.length > 1) {
    throw new DecompileBinaryError(
      `存在多个同名二进制：${candidates.join('、')}；请指明完整文件名。`,
      'invalid_input',
    );
  }
  // 零候选：附上父目录真实清单（若目录存在），帮助模型自助修正路径。
  let listingHint = '';
  try {
    const entries = await readdir(parentAbs);
    listingHint = entries.length
      ? `该目录实际内容（前 20 项）：${entries.slice(0, 20).join('、')}${entries.length > 20 ? '…' : ''}`
      : '该目录为空。';
  } catch {
    listingHint = `目录不存在：${parentRel}。快照内 SDK 一般在 <模块>/libs/ 下，可先用 search_project_text 搜 build.gradle 里的 files('libs/…') 引用确认路径。`;
  }
  throw new DecompileBinaryError(
    `未找到二进制文件：${relativePath}（仅支持 ${[...BINARY_EXTENSIONS].join('/')}）。${listingHint}`,
    'invalid_input',
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, suffix: string, relative = ''): Promise<string[]> {
  const dir = resolve(root, relative);
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await listFiles(root, suffix, child));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(child);
    }
  }
  return out;
}

export type RiskHit = { file: string; line: number; text: string };
export type DecompiledSummary = {
  classes: number;
  manifest: { permissions: string[]; queries: string[] } | null;
  riskIndex: Array<{ key: string; label: string; hits: RiskHit[] }>;
  truncated: boolean;
};

/** 扫描反编译产物生成行为索引：高风险 API 命中 + manifest 权限/queries 声明。 */
export async function summarizeDecompiledOutput(outputDir: string): Promise<DecompiledSummary> {
  const sourcesDir = join(outputDir, 'sources');
  const javaFiles = await listFiles(sourcesDir, '.java');
  const riskHits = new Map<string, RiskHit[]>();
  let totalHits = 0;
  let truncated = false;

  for (const file of javaFiles) {
    if (totalHits >= TOTAL_HIT_LIMIT) {
      truncated = true;
      break;
    }
    const lines = (await readFile(join(sourcesDir, file), 'utf8')).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!;
      for (const { key, pattern } of RISK_PATTERNS) {
        if (!pattern.test(text)) continue;
        const bucket = riskHits.get(key) ?? [];
        if (bucket.length >= PER_CATEGORY_LIMIT) continue;
        bucket.push({
          file,
          line: index + 1,
          text: text.trim().slice(0, HIT_LINE_MAX),
        });
        riskHits.set(key, bucket);
        totalHits += 1;
      }
      if (totalHits >= TOTAL_HIT_LIMIT) {
        truncated = true;
        break;
      }
    }
  }

  return {
    classes: javaFiles.length,
    manifest: await readManifestSummary(outputDir),
    riskIndex: RISK_PATTERNS.flatMap(({ key, label }) => {
      const hits = riskHits.get(key);
      return hits?.length ? [{ key, label, hits }] : [];
    }),
    truncated,
  };
}

async function readManifestSummary(outputDir: string): Promise<DecompiledSummary['manifest']> {
  const manifestPath = join(outputDir, 'resources', 'AndroidManifest.xml');
  if (!(await pathExists(manifestPath))) return null;
  const xml = await readFile(manifestPath, 'utf8');
  const permissions = [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((match) => match[1]!);
  // <queries> 段内的 package 声明与 intent action：包可见性视角的关键输入。
  const queriesBlock = /<queries>([\s\S]*?)<\/queries>/.exec(xml)?.[1] ?? '';
  const queries = [
    ...[...queriesBlock.matchAll(/<package[^>]*android:name="([^"]+)"/g)].map((match) => `package:${match[1]}`),
    ...[...queriesBlock.matchAll(/<action[^>]*android:name="([^"]+)"/g)].map((match) => `action:${match[1]}`),
  ];
  return { permissions, queries };
}

// 同内容哈希的并发反编译去重。
const inFlight = new Map<string, Promise<{ dir: string; reused: boolean }>>();

export type DecompileOptions = {
  workspacePath: string;
  relativePath: string;
  jadxPath: string;
  cacheRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  runner?: JadxRunner;
};

export type DecompileResult = {
  cacheDir: string;
  sha256: string;
  /** true = 产物来自已有缓存（本次未跑 jadx）。 */
  cached: boolean;
  /** 实际反编译的 workspace 相对路径（自动补全扩展名后与入参可能不同）。 */
  resolvedRelativePath: string;
  autoCompleted: boolean;
  summary: DecompiledSummary;
};

/** 反编译快照内二进制（带内容哈希缓存）；返回缓存目录与行为索引。 */
export async function decompileBinary(options: DecompileOptions): Promise<DecompileResult> {
  const resolvedPath = await resolveBinaryWithFallback(options.workspacePath, options.relativePath);
  const inputPath = resolvedPath.absPath;
  if (!(await pathExists(inputPath))) {
    throw new DecompileBinaryError(`快照内不存在该二进制：${options.relativePath}`, 'not_found');
  }
  const sha256 = createHash('sha256').update(await readFile(inputPath)).digest('hex');
  const cacheDir = resolve(resolve(options.cacheRoot), 'decompiled', sha256);
  const { dir, reused } = await ensureDecompiled({ ...options, inputPath, cacheDir });
  return {
    cacheDir: dir,
    sha256,
    cached: reused,
    resolvedRelativePath: resolvedPath.relativePath,
    autoCompleted: resolvedPath.autoCompleted,
    summary: await summarizeDecompiledOutput(dir),
  };
}

async function ensureDecompiled(
  options: DecompileOptions & { inputPath: string; cacheDir: string },
): Promise<{ dir: string; reused: boolean }> {
  const { inputPath, cacheDir } = options;
  if (await pathExists(join(cacheDir, DONE_MARKER))) return { dir: cacheDir, reused: true };
  const existing = inFlight.get(cacheDir);
  // 等待别的在途任务完成：对等待方而言产物同样是复用。
  if (existing) return existing.then((result) => ({ ...result, reused: true }));

  const task = (async (): Promise<{ dir: string; reused: boolean }> => {
    if (await pathExists(join(cacheDir, DONE_MARKER))) return { dir: cacheDir, reused: true };
    const root = resolve(options.cacheRoot);
    await mkdir(join(root, 'decompiled'), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(root, 'decompiled', `.tmp-${cacheDir.split(sep).pop()}-`));
    try {
      await (options.runner ?? spawnJadxRunner)({
        jadxPath: options.jadxPath,
        inputPath,
        outputDir: stage,
        timeoutMs: options.timeoutMs ?? 180_000,
        signal: options.signal,
      });
      await writeFile(join(stage, DONE_MARKER), new Date().toISOString(), { mode: 0o600 });
      try {
        await rename(stage, cacheDir);
      } catch {
        // 并发物化已被别的请求完成：丢弃本次产物，用已存在的。
        await rm(stage, { recursive: true, force: true });
      }
      return { dir: cacheDir, reused: false };
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    } finally {
      inFlight.delete(cacheDir);
    }
  })();
  inFlight.set(cacheDir, task);
  return task;
}

/** 读取产物中某个类的完整反编译源码（类名点号路径，支持不带 .java）。 */
export async function readDecompiledClass(
  cacheDir: string,
  className: string,
): Promise<{ path: string; content: string; truncated: boolean }> {
  const normalized = className.trim().replace(/\.java$/, '').replace(/\$/g, '.');
  if (!/^[A-Za-z0-9_.]+$/.test(normalized)) {
    throw new DecompileBinaryError(`类名格式不合法：${className}`, 'invalid_input');
  }
  const sourcesDir = resolve(cacheDir, 'sources');
  // 先按精确路径找（a.b.C → a/b/C.java），找不到再按文件名兜底匹配。
  const exact = resolve(sourcesDir, normalized.replace(/\./g, sep) + '.java');
  let target = isWithin(sourcesDir, exact) && (await pathExists(exact)) ? exact : null;
  if (!target) {
    const simpleName = normalized.split('.').pop()!;
    const matches = (await listFiles(sourcesDir, '.java'))
      .filter((file) => file === `${simpleName}.java` || file.endsWith(`/${simpleName}.java`)
        || file.endsWith(`/${normalized.replace(/\./g, '/')}.java`));
    if (matches.length === 0) {
      throw new DecompileBinaryError(
        `产物中未找到类 ${className}；可用 search 参数确认类名，或检查是否被混淆改名。`,
        'not_found',
      );
    }
    target = resolve(sourcesDir, matches[0]!);
  }
  const content = await readFile(target, 'utf8');
  return {
    path: target.slice(sourcesDir.length + 1),
    content: content.slice(0, CLASS_MAX_CHARS),
    truncated: content.length > CLASS_MAX_CHARS,
  };
}

/** 在全部反编译产物中做大小写不敏感文本搜索。 */
export async function searchDecompiledOutput(
  cacheDir: string,
  query: string,
): Promise<{ hits: RiskHit[]; truncated: boolean }> {
  const sourcesDir = resolve(cacheDir, 'sources');
  const needle = query.toLowerCase();
  const hits: RiskHit[] = [];
  let truncated = false;
  for (const file of await listFiles(sourcesDir, '.java')) {
    const lines = (await readFile(join(sourcesDir, file), 'utf8')).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]!.toLowerCase().includes(needle)) continue;
      hits.push({ file, line: index + 1, text: lines[index]!.trim().slice(0, HIT_LINE_MAX) });
      if (hits.length >= SEARCH_HIT_LIMIT) {
        truncated = true;
        return { hits, truncated };
      }
    }
  }
  return { hits, truncated };
}
