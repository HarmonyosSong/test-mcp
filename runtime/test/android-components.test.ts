import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parsePinnedModuleVersions,
  parseSettingsGradleModules,
  resolveAndroidComponents,
} from '../src/capabilities/android-components.js';
import { GitLabArchiveClient } from '../src/capabilities/gitlab-archive.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const RULES = { repo_map: { XesApp_Business_Modules: 'group/XesApp_Business_Modules' } };

const SETTINGS = `
include ':app'
if (!apphome.toBoolean()) {
    include ':apphome'
    project(':apphome').setProjectDir(new File('../XesApp_Business_Modules/apphome'))
}
if (!classgroup.toBoolean()) {
    include ':classgroup'
    project(':classgroup').setProjectDir(new File('../XesApp_Business_Modules/classgroup'))
}
if (!ahome.toBoolean()) {
    include ':ahome'
    project(':ahome').setProjectDir(new File('../cloudlearning/ahome'))
}
`;

const PROPERTIES = `
# 钉版本
apphome_PACKAGE_VERSION=7.105.0.5
classgroup_PACKAGE_VERSION=7.105.0.5
ahome_PACKAGE_VERSION=5.105.0.2
org.gradle.jvmargs=-Xmx4g
`;

async function workspace(run: (path: string) => Promise<void>, options?: { settings?: string | null; properties?: string | null }): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'android-components-'));
  try {
    if (options?.settings !== null) await writeFile(join(root, 'settings.gradle'), options?.settings ?? SETTINGS);
    if (options?.properties !== null) await writeFile(join(root, 'gradle.properties'), options?.properties ?? PROPERTIES);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mockClient(tagsBySearch: Record<string, Array<{ name: string; commit: string }>>): GitLabArchiveClient {
  return new GitLabArchiveClient({
    baseUrl: 'https://git.example.test',
    token: 'fixture',
    fetchImpl: async (input) => {
      const url = String(input);
      const search = new URL(url).searchParams.get('search') ?? '';
      const tags = tagsBySearch[search] ?? [];
      return Response.json(tags.map((tag) => ({ name: tag.name, commit: { id: tag.commit } })));
    },
  });
}

test('settings.gradle 只提取 ../仓库/模块 形式的本地组件，忽略普通 include', () => {
  assert.deepEqual(parseSettingsGradleModules(SETTINGS), [
    { repoDir: 'XesApp_Business_Modules', module: 'apphome' },
    { repoDir: 'XesApp_Business_Modules', module: 'classgroup' },
    { repoDir: 'cloudlearning', module: 'ahome' },
  ]);
});

test('settings.gradle 变量形式经 def 链解析仓库目录（pad 壳写法）', () => {
  const padSettings = `
def cloudlearningRootProp = gradleProps.getProperty("CLOUDLEARNING_ROOT", "../cloudlearning")
def cloudlearningRootDir = new File(cloudlearningRootProp).isAbsolute()
        ? new File(cloudlearningRootProp).canonicalFile
        : new File(rootDir, cloudlearningRootProp).canonicalFile
if (!classlearn.toBoolean()) {
    include ':classclean'
    project(':classclean').setProjectDir(new File(cloudlearningRootDir, 'classlearn'))
}
project(':ahome').setProjectDir(new File(cloudlearningRootDir, 'ahome'))
`;
  assert.deepEqual(parseSettingsGradleModules(padSettings), [
    { repoDir: 'cloudlearning', module: 'classlearn' },
    { repoDir: 'cloudlearning', module: 'ahome' },
  ]);
});

test('gradle.properties 接受 SNAPSHOT 后缀与五段钉版本', () => {
  assert.deepEqual(parsePinnedModuleVersions(`
apphome_PACKAGE_VERSION=7.106.1.1-SNAPSHOT
padhome_PACKAGE_VERSION=7.106.0.5.2-SNAPSHOT
course_PACKAGE_VERSION=7.106.0.0
bad_PACKAGE_VERSION=7.106
`), new Map([
    ['apphome', '7.106.1.1-SNAPSHOT'],
    ['padhome', '7.106.0.5.2-SNAPSHOT'],
    ['course', '7.106.0.0'],
  ]));
});

test('钉版本带 SNAPSHOT 后缀时匹配快照 tag 并标注', async () => {
  const snapshotSettings = `
project(':padhome').setProjectDir(new File('../xesApp_Pad_Android/padhome'))
`;
  await workspace(async (path) => {
    const client = mockClient({
      'padhome-V5.106.0.2-SNAPSHOT': [{ name: 'padhome-V5.106.0.2-SNAPSHOT-1325', commit: SHA_B }],
    });
    const result = await resolveAndroidComponents({
      workspacePath: path,
      client,
      rules: { repo_map: { xesApp_Pad_Android: 'group/xesApp_Pad_Android' } },
    });
    assert.equal(result.repositories.length, 1);
    assert.equal(result.repositories[0]!.ref, 'padhome-V5.106.0.2-SNAPSHOT-1325');
    assert.match(result.limitations.join(), /SNAPSHOT/);
  }, { settings: snapshotSettings, properties: 'padhome_PACKAGE_VERSION=5.106.0.2-SNAPSHOT\n' });
});

test('gradle.properties 只接受三/四段数字钉版本，忽略注释与非版本值', () => {
  assert.deepEqual(parsePinnedModuleVersions(PROPERTIES), new Map([
    ['apphome', '7.105.0.5'],
    ['classgroup', '7.105.0.5'],
    ['ahome', '5.105.0.2'],
  ]));
});

test('组件解析：正式 tag 优先、同 commit 合并快照、未映射仓库如实记录缺口', async () => {
  await workspace(async (path) => {
    const client = mockClient({
      'apphome-V7.105.0.5': [
        { name: 'apphome-V7.105.0.5-2771', commit: SHA_A },
        { name: 'apphome-V7.105.0.5-SNAPSHOT-4845', commit: SHA_B },
        { name: 'apphome-V7.105.0.5-2770', commit: SHA_A },
      ],
      'classgroup-V7.105.0.5': [{ name: 'classgroup-V7.105.0.5-2771', commit: SHA_A }],
    });
    const result = await resolveAndroidComponents({ workspacePath: path, client, rules: RULES });
    // 两个模块同 commit → 合并为一份快照，正式 tag（build 2771）优先于 SNAPSHOT 与低构建号
    assert.deepEqual(result.repositories, [{
      repository_id: 'group/XesApp_Business_Modules',
      role: 'component',
      mount_path: 'components/XesApp_Business_Modules',
      ref: 'apphome-V7.105.0.5-2771',
      expected_commit: SHA_A,
    }]);
    assert.match(result.limitations.join(), /cloudlearning/);
  });
});

test('同仓库不同 commit 的组件分别挂载并以 commit 后缀区分', async () => {
  await workspace(async (path) => {
    const client = mockClient({
      'apphome-V7.105.0.5': [{ name: 'apphome-V7.105.0.5-2771', commit: SHA_A }],
      'classgroup-V7.105.0.5': [{ name: 'classgroup-V7.105.0.5-3000', commit: SHA_B }],
    });
    const result = await resolveAndroidComponents({ workspacePath: path, client, rules: RULES });
    const mounts = result.repositories.map((repository) => repository.mount_path).sort();
    assert.deepEqual(mounts, [
      `components/XesApp_Business_Modules__${SHA_A.slice(0, 8)}`,
      `components/XesApp_Business_Modules__${SHA_B.slice(0, 8)}`,
    ]);
  });
});

test('只有 SNAPSHOT tag 时挂载并标注；模块无 tag 记为缺口', async () => {
  await workspace(async (path) => {
    const client = mockClient({
      'apphome-V7.105.0.5': [{ name: 'apphome-V7.105.0.5-SNAPSHOT-4845', commit: SHA_B }],
    });
    const result = await resolveAndroidComponents({ workspacePath: path, client, rules: RULES });
    assert.equal(result.repositories.length, 1);
    assert.match(result.limitations.join(), /SNAPSHOT/);
    assert.match(result.limitations.join(), /classgroup 未挂载/);
  });
});

test('缺少构建文件或未配置凭据时不抛错，返回缺口说明', async () => {
  await workspace(async (path) => {
    const missing = await resolveAndroidComponents({ workspacePath: path, client: null, rules: RULES });
    assert.equal(missing.repositories.length, 0);
    assert.match(missing.limitations.join(), /settings\.gradle/);
  }, { settings: null });
  await workspace(async (path) => {
    const noClient = await resolveAndroidComponents({ workspacePath: path, client: null, rules: RULES });
    assert.equal(noClient.repositories.length, 0);
    assert.match(noClient.limitations.join(), /未配置 GitLab API 凭据/);
  });
});
