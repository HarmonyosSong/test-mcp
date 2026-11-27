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

test('产品线未指明时默认学而思，显式提到学家云（含历史消息）不被默认值覆盖', () => {
  // 全文不提 App：按默认学而思解析，登记表不再因「命中多个产品线」失败。
  assert.deepEqual(resolvePromptSourceContext('Android 支付失败', {
    platform: null,
    product_line: null,
    form_factor: null,
    version: null,
    build: null,
  }), {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: null,
    version: null,
    build: null,
  });
  // 历史消息提到学家云：检测值优先于默认值（历史版本号一并沿用）。
  assert.deepEqual(resolvePromptSourceContext('Android 支付失败', {
    platform: null,
    product_line: null,
    form_factor: null,
    version: null,
    build: null,
    promptHistory: ['学家云 5.106.0 的作业列表'],
  }), {
    platform: 'android',
    productLine: 'xuejiayun',
    formFactor: null,
    version: '5.106.0',
    build: null,
  });
  // 本会话已确定学家云：沿用会话值。
  assert.equal(
    resolvePromptSourceContext('Android 支付失败', {
      platform: null,
      product_line: 'xuejiayun',
      form_factor: null,
      version: null,
      build: null,
    })?.productLine,
    'xuejiayun',
  );
});

test('否定表述不误判形态：「安卓端手机版（非 HD/平板）」解析为 phone', () => {
  const scope = resolvePromptSourceContext('学而思 App 安卓端手机版（非 HD/平板）7.106.0，招商银行支付无法拉起', {
    platform: null, product_line: null, form_factor: null, version: null, build: null,
  });
  assert.equal(scope?.platform, 'android');
  assert.equal(scope?.formFactor, 'phone');
  assert.equal(scope?.version, '7.106.0');
});

test('否定表述不误判平台：「不是鸿蒙的问题，安卓上复现」解析为 android', () => {
  const scope = resolvePromptSourceContext('不是鸿蒙的问题，在安卓上复现了', {
    platform: null, product_line: null, form_factor: null, version: null, build: null,
  });
  assert.equal(scope?.platform, 'android');
});

test('端形态双命中（手机+平板）抛歧义，不静默二选一', () => {
  assert.throws(
    () => resolvePromptSourceContext('手机和平板都出现这个问题', {
      platform: null, product_line: null, form_factor: null, version: null, build: null,
    }),
    (error: unknown) => error instanceof PromptVersionContextError && /端形态/.test(error.message),
  );
});

test('回归：「学而思 HD 黑屏」仍解析为 pad', () => {
  const scope = resolvePromptSourceContext('学而思 HD 黑屏', {
    platform: null, product_line: null, form_factor: null, version: null, build: null,
  });
  assert.equal(scope?.formFactor, 'pad');
});
