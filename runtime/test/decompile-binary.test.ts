import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  decompileBinary,
  DecompileBinaryError,
  readDecompiledClass,
  resolveBinaryPath,
  resolveBinaryWithFallback,
  searchDecompiledOutput,
  type JadxRunner,
} from '../src/capabilities/decompile-binary.js';
import { createDecompileBinaryTool } from '../src/capabilities/decompile-binary-tool.js';
import { ConversationRecordSchema } from '../src/domain/schemas.js';

const timestamp = '2026-11-27T00:00:00.000Z';

/** 假 jadx：产物目录里生成两个类（一个含包枚举安装检测）与 manifest。 */
const fakeRunner: JadxRunner = async ({ outputDir }) => {
  await mkdir(join(outputDir, 'sources', 'cmbapi'), { recursive: true });
  await mkdir(join(outputDir, 'resources'), { recursive: true });
  await writeFile(join(outputDir, 'sources', 'cmbapi', 'a.java'), [
    'package cmbapi;',
    'public class a {',
    '  public boolean isCMBAppInstalled(Context ctx) {',
    '    List<PackageInfo> pkgs = ctx.getPackageManager().getInstalledPackages(0);',
    '    for (PackageInfo p : pkgs) { if ("cmb.pb".equals(p.packageName)) return true; }',
    '    return false;',
    '  }',
    '}',
  ].join('\n'));
  await writeFile(join(outputDir, 'sources', 'cmbapi', 'b.java'), [
    'package cmbapi;',
    'public class b {',
    '  void pay() { Cipher.getInstance("RSA"); }',
    '}',
  ].join('\n'));
  await writeFile(join(outputDir, 'resources', 'AndroidManifest.xml'), [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="cmb.android">',
    '  <uses-permission android:name="android.permission.INTERNET"/>',
    '</manifest>',
  ].join('\n'));
};

async function makeWorkspace(): Promise<{ workspace: string; cacheRoot: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'decompile-test-'));
  const workspace = join(root, 'workspace');
  const cacheRoot = join(root, 'cache');
  await mkdir(join(workspace, 'purchase', 'libs'), { recursive: true });
  await writeFile(join(workspace, 'purchase', 'libs', 'cmbsdk-release-1.1.0.aar'), 'fake-aar-bytes');
  await writeFile(join(workspace, 'readme.txt'), 'not a binary');
  return { workspace, cacheRoot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('路径越界与不支持的扩展名被拒绝', async () => {
  const { workspace, cleanup } = await makeWorkspace();
  try {
    assert.throws(() => resolveBinaryPath(workspace, '../outside.aar'), /越界/);
    assert.throws(() => resolveBinaryPath(workspace, 'readme.txt'), /不支持/);
    assert.equal(
      resolveBinaryPath(workspace, 'purchase/libs/cmbsdk-release-1.1.0.aar').endsWith('cmbsdk-release-1.1.0.aar'),
      true,
    );
  } finally {
    await cleanup();
  }
});

test('无后缀路径自动补全：build.gradle 的 files(libs/xxx) 引用可直接用', async () => {
  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  try {
    // list_project_files 只列文本文件，模型从 build.gradle 拿到的无后缀引用必须靠工具补全。
    const resolved = await resolveBinaryWithFallback(workspace, 'purchase/libs/cmbsdk-release-1.1.0');
    assert.equal(resolved.autoCompleted, true);
    assert.equal(resolved.relativePath, 'purchase/libs/cmbsdk-release-1.1.0.aar');

    const result = await decompileBinary({
      workspacePath: workspace,
      relativePath: 'purchase/libs/cmbsdk-release-1.1.0',
      jadxPath: 'unused',
      cacheRoot,
      runner: fakeRunner,
    });
    assert.equal(result.autoCompleted, true);
    assert.equal(result.resolvedRelativePath, 'purchase/libs/cmbsdk-release-1.1.0.aar');
    assert.equal(result.summary.classes, 2);
  } finally {
    await cleanup();
  }
});

test('补全失败时报错附目录真实清单；多个同名二进制列候选', async () => {
  const { workspace, cleanup } = await makeWorkspace();
  try {
    // 零候选：附目录实际内容
    await assert.rejects(
      () => resolveBinaryWithFallback(workspace, 'purchase/libs/not-exist-sdk'),
      /该目录实际内容.*cmbsdk-release-1\.1\.0\.aar/,
    );
    // 目录不存在：指引搜 build.gradle
    await assert.rejects(
      () => resolveBinaryWithFallback(workspace, 'no/such/dir/sdk'),
      /目录不存在/,
    );
    // 多候选：同名 aar + jar 时列清单
    await writeFile(join(workspace, 'purchase', 'libs', 'cmbsdk-release-1.1.0.jar'), 'jar-bytes');
    await assert.rejects(
      () => resolveBinaryWithFallback(workspace, 'purchase/libs/cmbsdk-release-1.1.0'),
      /多个同名二进制.*cmbsdk-release-1\.1\.0\.aar.*cmbsdk-release-1\.1\.0\.jar/,
    );
  } finally {
    await cleanup();
  }
});

test('反编译生成行为索引：包枚举安装检测与加解密命中、manifest 权限提取', async () => {
  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  try {
    const result = await decompileBinary({
      workspacePath: workspace,
      relativePath: 'purchase/libs/cmbsdk-release-1.1.0.aar',
      jadxPath: 'unused',
      cacheRoot,
      runner: fakeRunner,
    });
    assert.equal(result.cached, false);
    assert.equal(result.summary.classes, 2);
    assert.deepEqual(result.summary.manifest?.permissions, ['android.permission.INTERNET']);
    const visibility = result.summary.riskIndex.find((item) => item.key === 'package-visibility');
    assert.ok(visibility, '应命中包可见性类别');
    assert.match(visibility.hits[0]!.file, /cmbapi\/a\.java/);
    assert.match(visibility.hits[0]!.text, /getInstalledPackages/);
    assert.ok(result.summary.riskIndex.some((item) => item.key === 'crypto'));
  } finally {
    await cleanup();
  }
});

test('产物按内容哈希缓存：第二次调用不再跑 jadx', async () => {
  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  let runs = 0;
  const countingRunner: JadxRunner = async (options) => {
    runs += 1;
    await fakeRunner(options);
  };
  try {
    const first = await decompileBinary({
      workspacePath: workspace, relativePath: 'purchase/libs/cmbsdk-release-1.1.0.aar',
      jadxPath: 'unused', cacheRoot, runner: countingRunner,
    });
    const second = await decompileBinary({
      workspacePath: workspace, relativePath: 'purchase/libs/cmbsdk-release-1.1.0.aar',
      jadxPath: 'unused', cacheRoot, runner: countingRunner,
    });
    assert.equal(runs, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.summary.classes, 2);
  } finally {
    await cleanup();
  }
});

test('class_name 读取具体类源码；search 全文搜索', async () => {
  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  try {
    const { cacheDir } = await decompileBinary({
      workspacePath: workspace, relativePath: 'purchase/libs/cmbsdk-release-1.1.0.aar',
      jadxPath: 'unused', cacheRoot, runner: fakeRunner,
    });
    const klass = await readDecompiledClass(cacheDir, 'cmbapi.a');
    assert.match(klass.content, /isCMBAppInstalled/);
    // 文件名兜底（不带包名）
    const bySimpleName = await readDecompiledClass(cacheDir, 'b');
    assert.match(bySimpleName.path, /cmbapi\/b\.java/);
    await assert.rejects(() => readDecompiledClass(cacheDir, 'cmbapi.missing'), /未找到类/);
    await assert.rejects(() => readDecompiledClass(cacheDir, '../etc/passwd'), /不合法/);

    const found = await searchDecompiledOutput(cacheDir, 'CMB.PB');
    assert.equal(found.hits.length, 1);
    assert.match(found.hits[0]!.text, /cmb\.pb/);
  } finally {
    await cleanup();
  }
});

function makeConversation(workspacePath: string | null) {
  const conversation = ConversationRecordSchema.parse({
    id: 'conv-decompile',
    title: 't',
    messages: [{ id: 'msg-1', role: 'user', content: '招行支付拉不起来', created_at: timestamp }],
    created_at: timestamp,
    updated_at: timestamp,
  });
  conversation.workspace_path = workspacePath;
  return conversation;
}

test('工具：未绑定快照返回 unbound；jadx 缺席返回 unavailable', async () => {
  const unbound = createDecompileBinaryTool({
    conversation: makeConversation(null), jadxPath: 'unused', cacheRoot: '/unused',
  });
  const unboundResult = await unbound.execute!({ relative_path: 'a.aar' }, {} as never) as Record<string, unknown>;
  assert.equal(unboundResult.status, 'unbound');

  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  try {
    const tool = createDecompileBinaryTool({
      conversation: makeConversation(workspace), jadxPath: '/nonexistent/jadx', cacheRoot,
      runner: () => Promise.reject(new DecompileBinaryError('未找到 jadx', 'jadx_unavailable')),
    });
    const result = await tool.execute!(
      { relative_path: 'purchase/libs/cmbsdk-release-1.1.0.aar' }, {} as never,
    ) as Record<string, unknown>;
    assert.equal(result.status, 'unavailable');
    assert.match(String(result.limitation), /jadx/);
  } finally {
    await cleanup();
  }
});

test('工具：反编译后缺省复用最近产物（class_name/search 免 relative_path）', async () => {
  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  try {
    const tool = createDecompileBinaryTool({
      conversation: makeConversation(workspace), jadxPath: 'unused', cacheRoot, runner: fakeRunner,
    });
    const first = await tool.execute!(
      { relative_path: 'purchase/libs/cmbsdk-release-1.1.0.aar' }, {} as never,
    ) as Record<string, unknown>;
    assert.equal(first.status, 'decompiled');
    const info = first.binary_info as Record<string, unknown>;
    assert.equal(info.classes, 2);
    assert.ok(Object.keys(info.risk_index as object).some((key) => key.includes('package-visibility')));

    const classResult = await tool.execute!({ class_name: 'cmbapi.a' }, {} as never) as Record<string, unknown>;
    assert.equal(classResult.status, 'decompiled');
    assert.match(String((classResult.class_source as Record<string, unknown>).content), /getInstalledPackages/);

    const searchResult = await tool.execute!({ search: 'cmb.pb' }, {} as never) as Record<string, unknown>;
    assert.equal((searchResult.search_result as Record<string, unknown>).query, 'cmb.pb');

    // 从未反编译过的工具实例：只传 search 必须提示先传 relative_path
    const fresh = createDecompileBinaryTool({
      conversation: makeConversation(workspace), jadxPath: 'unused', cacheRoot, runner: fakeRunner,
    });
    const missing = await fresh.execute!({ search: 'x' }, {} as never) as Record<string, unknown>;
    assert.equal(missing.status, 'unresolved');
    assert.match(String(missing.limitation), /relative_path/);
  } finally {
    await cleanup();
  }
});

test('工具：快照内不存在的二进制返回 unresolved', async () => {
  const { workspace, cacheRoot, cleanup } = await makeWorkspace();
  try {
    const tool = createDecompileBinaryTool({
      conversation: makeConversation(workspace), jadxPath: 'unused', cacheRoot, runner: fakeRunner,
    });
    const result = await tool.execute!(
      { relative_path: 'purchase/libs/missing.aar' }, {} as never,
    ) as Record<string, unknown>;
    assert.equal(result.status, 'unresolved');
    assert.match(String(result.limitation), /不存在/);
  } finally {
    await cleanup();
  }
});
