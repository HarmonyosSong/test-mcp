import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PromptVersionContextError,
  resolvePromptSourceContext,
} from '../src/capabilities/prompt-version-context.js';

test('从用户提示词读取平台、产品线和精确版本', () => {
  assert.deepEqual(resolvePromptSourceContext('Android 学而思 7.106.5 build 55364 的问题', {
    platform: null,
    product_line: null,
    form_factor: null,
    version: null,
    build: null,
  }), {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: null,
    version: '7.106.5',
    build: '55364',
  });
});

test('提示词没有版本时沿用会话端上下文，让登记表选择最新版本', () => {
  assert.deepEqual(resolvePromptSourceContext('请排查英语绘本阅读排行榜接口问题', {
    platform: 'ios',
    product_line: 'xuejiayun',
    form_factor: 'phone',
    version: null,
    build: null,
  }), {
    platform: 'ios',
    productLine: 'xuejiayun',
    formFactor: 'phone',
    version: null,
    build: null,
  });
});

test('提示词版本有歧义时拒绝自动绑定', () => {
  assert.throws(
    () => resolvePromptSourceContext('7.106.4 升级到 7.106.5 后出现问题', {
      platform: 'android',
      product_line: 'xueersi',
      form_factor: null,
      version: null,
      build: null,
    }),
    (error: unknown) => error instanceof PromptVersionContextError && /版本号/.test(error.message),
  );
});

test('显式切换平台时不继承历史平台的版本和形态', () => {
  assert.deepEqual(resolvePromptSourceContext('请查 Android 代码', {
    platform: null,
    product_line: 'xueersi',
    form_factor: null,
    version: null,
    build: null,
    promptHistory: ['请查 HarmonyOS HD 7.106.0 的问题'],
  }), {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: null,
    version: null,
    build: null,
  });
});

test('问题平台和对照平台同时出现时只绑定实际受影响的平台', () => {
  assert.deepEqual(resolvePromptSourceContext('鸿蒙学生端点击绘本白屏，安卓没复现', {
    platform: null,
    product_line: 'xueersi',
    form_factor: 'pad',
    version: null,
    build: null,
  }), {
    platform: 'harmony',
    productLine: 'xueersi',
    formFactor: 'pad',
    version: null,
    build: null,
  });
});

test('两个平台都出现问题时仍拒绝自动绑定', () => {
  assert.throws(
    () => resolvePromptSourceContext('鸿蒙和安卓都出现白屏问题', {
      platform: null,
      product_line: 'xueersi',
      form_factor: null,
      version: null,
      build: null,
    }),
    (error: unknown) => error instanceof PromptVersionContextError && /平台/.test(error.message),
  );
});

test('先记录提示词里的部分上下文，等待 LogCenter 补齐端后再绑定', () => {
  assert.deepEqual(resolvePromptSourceContext('请排查学而思的登录问题', {
    platform: null,
    product_line: null,
    form_factor: null,
    version: null,
    build: null,
  }), {
    platform: null,
    productLine: 'xueersi',
    formFactor: null,
    version: null,
    build: null,
  });
});
